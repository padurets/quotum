//! The settings the app changes: in the agent's own `config.toml`, the one file `quotum`
//! reads too, so what is set here holds for the command-line agent after the app quits.
//! Only the keys asked are changed; the person's comments, order and other keys stay, and
//! so do the file's permissions and a symbolic link in its place.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use quotum_core::config::Config;
use quotum_core::model::Provider;
use serde::{Deserialize, Deserializer};
use toml_edit::{DocumentMut, Item, Table, value};

/// What the board may change: nothing else (not a client's path, not a hub).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    #[serde(default)]
    pub providers: BTreeMap<Provider, ProviderPatch>,
    pub sessions: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProviderPatch {
    pub enabled: Option<bool>,
    /// Seconds; `null` takes the provider's own interval out (the hub then measures it as
    /// often as needed, or as set for all). Left out, the interval stays as it is.
    #[serde(default, deserialize_with = "present")]
    pub interval_s: Option<Option<u64>>,
    /// The name of the subscription (Antigravity); empty removes it.
    pub account: Option<String>,
}

/// A field that is there, `null` included: told apart from one left out (`#[serde(default)]`).
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<u64>>, D::Error> {
    Option::<u64>::deserialize(deserializer).map(Some)
}

/// `text` with the patch applied, checked as the agent checks the file when it reads it.
pub fn apply(text: &str, patch: &Patch) -> Result<String, String> {
    let mut doc: DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    if let Some(sessions) = patch.sessions {
        doc["sessions"] = value(sessions);
    }
    for (provider, change) in &patch.providers {
        if *change == ProviderPatch::default() {
            continue;
        }
        if doc.get("providers").is_none() {
            // Shown as [providers.<id>] tables, not as an empty [providers].
            let mut providers = Table::new();
            providers.set_implicit(true);
            doc.insert("providers", Item::Table(providers));
        }
        let providers = &mut doc["providers"];
        if providers.get(provider.id()).is_none() {
            providers[provider.id()] = Item::Table(Table::new());
        }
        let table = &mut providers[provider.id()];
        if let Some(enabled) = change.enabled {
            table["enabled"] = value(enabled);
        }
        match change.interval_s {
            Some(Some(seconds)) => {
                table["interval"] = value(i64::try_from(seconds).map_err(|_| "the interval is too long".to_string())?)
            }
            Some(None) => {
                if let Some(table) = table.as_table_like_mut() {
                    table.remove("interval");
                }
            }
            None => {}
        }
        match change.account.as_deref().map(str::trim) {
            Some("") => {
                if let Some(table) = table.as_table_like_mut() {
                    table.remove("account");
                }
            }
            Some(name) => table["account"] = value(name),
            None => {}
        }
    }
    let text = doc.to_string();
    Config::parse(&text)?;
    Ok(text)
}

/// Changes the settings file at `path` (created, with its directory, if there is none).
pub fn save(path: &Path, patch: &Patch) -> Result<(), String> {
    let at = |e: io::Error, file: &Path| format!("{}: {e}", file.display());
    // A link stays a link: what it points to is written.
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path).map_err(|e| at(e, path))?,
        _ => path.to_path_buf(),
    };
    let text = match fs::read_to_string(&target) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(at(e, &target)),
    };
    let text = apply(&text, patch).map_err(|e| format!("{}: {e}", target.display()))?;
    if let Some(dir) = target.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).map_err(|e| at(e, dir))?;
    }
    write_replacing(&target, &text).map_err(|e| at(e, &target))
}

/// Writes a new file next to `target` and puts it in its place, with the old one's
/// permissions. A new file is private on Unix and inherits its folder's ACL on Windows.
fn write_replacing(target: &Path, text: &str) -> io::Result<()> {
    let mut next = Temporary::new(target)?;
    let file = next.file.as_mut().expect("the temporary file is open");
    file.write_all(text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(target).map(|m| m.permissions().mode() & 0o7777).unwrap_or(0o600);
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    // Windows replacement needs the writing handle closed first.
    next.file.take();
    replace(&next.path, target).inspect_err(|_| {
        // ReplaceFile can fail after removing the old name. Keep the new data then.
        next.keep = !target.exists();
    })
}

/// Its name is never reused, even after a crash; a failed write removes only its own file.
struct Temporary {
    path: PathBuf,
    file: Option<fs::File>,
    keep: bool,
}

impl Temporary {
    fn new(target: &Path) -> io::Result<Self> {
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for _ in 0..5 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|e| io::Error::other(e.to_string()))?;
            let path = target.with_file_name(format!(".{name}.quotum-app.{:032x}.new", u128::from_ne_bytes(random)));
            match create_private(&path, target) {
                Ok(file) => return Ok(Self { path, file: Some(file), keep: false }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "could not create a unique settings file"))
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        self.file.take();
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn create_private(next: &Path, _: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // The file may contain a hub token. No reader may open a broader copy before chmod.
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(next)
}

#[cfg(windows)]
fn create_private(next: &Path, target: &Path) -> io::Result<fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, PROTECTED_DACL_SECURITY_INFORMATION,
        SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, SetFileSecurityW, SetSecurityDescriptorControl,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut original = file_dacl(target)?;
    let mut security = original.clone();
    if let Some(sd) = &mut security {
        // SAFETY: the descriptor returned by GetFileSecurityW is aligned and lives
        // through the creation call. Protect only this copy of it.
        if unsafe { SetSecurityDescriptorControl(sd.as_mut_ptr().cast(), SE_DACL_PROTECTED, SE_DACL_PROTECTED) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.as_mut().map_or(std::ptr::null_mut(), |sd| sd.as_mut_ptr().cast()),
        bInheritHandle: 0,
    };
    let name = wide(next);
    // SAFETY: the path and aligned descriptor buffer live through CreateFileW. CREATE_NEW
    // refuses existing files and links; the returned handle is owned by File exactly once.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a valid handle, now transferred to File.
    let file = unsafe { fs::File::from_raw_handle(handle) };
    let normalized = (|| {
        let Some(sd) = &mut original else { return Ok(()) };
        let ptr = sd.as_mut_ptr().cast();
        let (mut control, mut revision) = (0, 0);
        // SAFETY: the original descriptor and terminated name remain valid throughout.
        unsafe {
            if GetSecurityDescriptorControl(ptr, &mut control, &mut revision) == 0 {
                return Err(io::Error::last_os_error());
            }
            let inheritance = if control & SE_DACL_PROTECTED != 0 {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
            // Creation can turn inherited ACEs into explicit grants. Restore the exact
            // original DACL before writing: otherwise ReplaceFile keeps duplicate grants
            // that survive a later revocation on the parent. This low-level setter copies
            // the descriptor without adding potentially broader current parent permissions.
            if SetFileSecurityW(name.as_ptr(), DACL_SECURITY_INFORMATION | inheritance, ptr) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    })();
    if let Err(error) = normalized {
        drop(file);
        let _ = fs::remove_file(next);
        return Err(error);
    }
    Ok(file)
}

/// Existing permissions apply at creation, before anyone can open the temporary file.
/// A missing target alone allows the normal inherited ACL of a new settings file.
#[cfg(windows)]
fn file_dacl(target: &Path) -> io::Result<Option<Vec<usize>>> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, GetFileSecurityW};

    let target = wide(target);
    let mut size = 0;
    // SAFETY: the first call only asks for the required buffer size; the path is terminated.
    unsafe { GetFileSecurityW(target.as_ptr(), DACL_SECURITY_INFORMATION, std::ptr::null_mut(), 0, &mut size) };
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::NotFound {
        return Ok(None);
    }
    if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(error);
    }
    // A security descriptor requires aligned storage, even though its length is in bytes.
    let mut descriptor = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let ptr = descriptor.as_mut_ptr().cast();
    // SAFETY: ptr has at least size bytes of aligned storage and outlives the call.
    if unsafe { GetFileSecurityW(target.as_ptr(), DACL_SECURITY_INFORMATION, ptr, size, &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(descriptor))
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(not(windows))]
fn replace(next: &Path, target: &Path) -> io::Result<()> {
    fs::rename(next, target)
}

#[cfg(windows)]
fn replace(next: &Path, target: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !target.try_exists()? {
        return fs::rename(next, target);
    }
    let (next, target) = (wide(next), wide(target));
    // ReplaceFile preserves the original ACL, including its inheritance policy, rather
    // than leaving the temporary file's protected ACL. Do not ignore a merge error.
    let replaced = unsafe {
        ReplaceFileW(target.as_ptr(), next.as_ptr(), std::ptr::null(), 0, std::ptr::null(), std::ptr::null())
    };
    if replaced == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(json: &str) -> Patch {
        serde_json::from_str(json).unwrap()
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quotum-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_keys_asked_change_and_the_persons_comments_stay() {
        let text = "# mine\ninterval = 300 # five minutes\n\n[hub]\nurl = \"https://q.example\"\ntoken = \"t\"\n\n[providers.codex]\n# keep\nenabled = true\npath = \"/opt/codex\"\n";
        let changed = apply(
            text,
            &patch(r#"{"sessions":false,"providers":{"codex":{"enabled":false,"intervalS":600},"antigravity":{"account":"work"}}}"#),
        )
        .unwrap();
        assert!(changed.starts_with("# mine\ninterval = 300 # five minutes\n"), "{changed}");
        assert!(changed.contains("# keep\nenabled = false\npath = \"/opt/codex\"\ninterval = 600"), "{changed}");
        assert!(changed.contains("[providers.antigravity]\naccount = \"work\""), "{changed}");
        let config = Config::parse(&changed).unwrap();
        assert!(!config.sessions() && !config.enabled(Provider::Codex));
        assert_eq!(config.hub.unwrap().url, "https://q.example");
        let cleared = apply(&changed, &patch(r#"{"providers":{"antigravity":{"account":" "}}}"#)).unwrap();
        assert_eq!(Config::parse(&cleared).unwrap().account_name(Provider::Antigravity), None);
    }

    #[test]
    fn an_interval_set_to_null_is_taken_out_and_one_left_out_stays() {
        let text = "[providers.codex]\ninterval = 600\n";
        let auto = apply(text, &patch(r#"{"providers":{"codex":{"intervalS":null}}}"#)).unwrap();
        assert_eq!(Config::parse(&auto).unwrap().min_interval_ms(Provider::Codex), None, "{auto}");
        let set = apply(&auto, &patch(r#"{"providers":{"codex":{"intervalS":120}}}"#)).unwrap();
        assert_eq!(Config::parse(&set).unwrap().min_interval_ms(Provider::Codex), Some(120_000));
        assert_eq!(
            apply(text, &patch(r#"{"providers":{"codex":{"enabled":true}}}"#)).unwrap(),
            "[providers.codex]\ninterval = 600\nenabled = true\n"
        );
        assert_eq!(
            patch(r#"{"providers":{"codex":{}}}"#).providers[&Provider::Codex],
            ProviderPatch::default(),
            "nothing asked"
        );
    }

    #[test]
    fn what_the_agent_would_refuse_is_not_written() {
        assert!(apply("", &patch(r#"{"providers":{"claude":{"intervalS":30}}}"#)).unwrap_err().contains("interval"));
        assert!(serde_json::from_str::<Patch>(r#"{"providers":{"claude":{"path":"/tmp/x"}}}"#).is_err(), "no path");
        assert!(serde_json::from_str::<Patch>(r#"{"hub":{"url":"x"}}"#).is_err(), "no hub");
        assert!(serde_json::from_str::<Patch>(r#"{"providers":{"cursor":{"enabled":true}}}"#).is_err());
    }

    #[test]
    fn an_inline_table_of_providers_is_changed_in_place() {
        let changed = apply(
            "providers = { claude = { enabled = true } }\n",
            &patch(r#"{"providers":{"claude":{"enabled":false}}}"#),
        )
        .unwrap();
        assert!(!Config::parse(&changed).unwrap().enabled(Provider::Claude), "{changed}");
    }

    #[test]
    fn a_missing_file_and_directory_are_created_with_the_keys_asked_only() {
        let dir = temp("new");
        let file = dir.join("quotum/config.toml");
        save(&file, &patch(r#"{"sessions":true,"providers":{"claude":{"enabled":false}}}"#)).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text, "sessions = true\n\n[providers.claude]\nenabled = false\n");
        assert!(Config::parse(&text).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn permissions_and_a_link_in_place_of_the_file_stay() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("unix");
        let real = dir.join("dotfiles-config.toml");
        fs::write(&real, "sessions = true\n").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("config.toml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        save(&link, &patch(r#"{"sessions":false}"#)).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "still a link");
        assert_eq!(fs::read_to_string(&real).unwrap(), "sessions = false\n");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn temporary_files_are_unique_and_removed_when_a_write_is_abandoned() {
        let dir = temp("temporary");
        let target = dir.join("config.toml");
        fs::write(&target, "sessions = true\n").unwrap();
        let mut first = Temporary::new(&target).unwrap();
        let second = Temporary::new(&target).unwrap();
        assert_ne!(first.path, second.path);
        first.file.as_mut().unwrap().write_all(b"incomplete").unwrap();
        let paths = [first.path.clone(), second.path.clone()];
        drop(first);
        drop(second);
        assert!(paths.iter().all(|path| !path.exists()), "no abandoned temporary files");
        assert_eq!(fs::read_to_string(&target).unwrap(), "sessions = true\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_existing_temporary_name_is_never_opened_or_truncated() {
        let dir = temp("collision");
        let target = dir.join("config.toml");
        let next = dir.join("occupied.new");
        fs::write(&target, "sessions = true\n").unwrap();
        fs::write(&next, "another writer").unwrap();
        assert_eq!(create_private(&next, &target).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&next).unwrap(), "another writer");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_file_is_private_from_creation_before_any_contents_are_written() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("creation-mode");
        let target = dir.join("config.toml");
        fs::write(&target, "sessions = true\n").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        // Inspect the result of the create syscall itself, before write_replacing can
        // write data or restore the target's final permissions.
        for existing in [true, false] {
            if !existing {
                fs::remove_file(&target).unwrap();
            }
            let next = dir.join("created.new");
            let file = create_private(&next, &target).unwrap();
            assert_eq!(file.metadata().unwrap().len(), 0);
            assert_eq!(file.metadata().unwrap().permissions().mode() & 0o077, 0, "private even in a public directory");
            drop(file);
            fs::remove_file(next).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_symlink_cannot_redirect_the_write() {
        let dir = temp("temporary-symlink");
        let target = dir.join("config.toml");
        let victim = dir.join("other-file");
        let next = dir.join("occupied.new");
        fs::write(&victim, "untouched").unwrap();
        std::os::unix::fs::symlink(&victim, &next).unwrap();
        assert_eq!(create_private(&next, &target).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(victim).unwrap(), "untouched");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    fn windows_script(file: &Path, script: &str) -> Vec<u8> {
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &format!("$ErrorActionPreference='Stop'; {script}")])
            .env("QUOTUM_TEST_FILE", file)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        output.stdout
    }

    #[cfg(windows)]
    fn windows_acl(file: &Path, restrict: bool) -> Vec<u8> {
        let protect = if restrict {
            "$a=New-Object Security.AccessControl.FileSecurity; $a.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $r=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $a.AddAccessRule($r); [IO.File]::SetAccessControl($env:QUOTUM_TEST_FILE,$a);"
        } else {
            ""
        };
        // Compare the protection policy and every ACE, including inherited flags and
        // duplicates. AUTO_INHERITED is bookkeeping, not a permission or inheritance rule.
        windows_script(
            file,
            &format!(
                r#"
            {protect}
            $a=[IO.File]::GetAccessControl($env:QUOTUM_TEST_FILE)
            $raw=[Security.AccessControl.RawSecurityDescriptor]::new($a.GetSecurityDescriptorBinaryForm(),0)
            $aces=@($raw.DiscretionaryAcl | ForEach-Object {{
                $bytes=New-Object byte[] $_.BinaryLength
                $_.GetBinaryForm($bytes,0)
                [Convert]::ToBase64String($bytes)
            }})
            [ordered]@{{protected=$a.AreAccessRulesProtected; nullDacl=($null -eq $raw.DiscretionaryAcl); aces=$aces}} | ConvertTo-Json -Compress
        "#
            ),
        )
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_temporary_file_has_the_protected_dacl_before_any_write() {
        let dir = temp("creation-acl");
        let target = dir.join("config.toml");
        fs::write(&target, "sessions = true\n").unwrap();
        let restricted = windows_acl(&target, true);
        // A normal new file inherits the broader parent ACL: this is the negative control.
        let ordinary = dir.join("inherited.txt");
        fs::write(&ordinary, "").unwrap();
        assert_ne!(windows_acl(&ordinary, false), restricted);
        let next = dir.join("created.new");
        let file = create_private(&next, &target).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 0);
        assert_eq!(windows_acl(&next, false), restricted, "protected at creation, before write or ReplaceFileW");
        drop(file);
        fs::remove_file(&next).unwrap();
        fs::remove_file(&target).unwrap();
        let file = create_private(&next, &target).unwrap();
        assert_eq!(windows_acl(&next, false), windows_acl(&ordinary, false), "a new config inherits normally");
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_files_explicit_acl_stays_when_settings_change() {
        let dir = temp("windows-acl");
        let file = dir.join("config.toml");
        fs::write(&file, "# keep\nsessions = true\n").unwrap();
        let before = windows_acl(&file, true);
        save(&file, &patch(r#"{"sessions":false}"#)).unwrap();
        assert_eq!(windows_acl(&file, false), before, "the protected ACL must survive replacement");
        assert_eq!(fs::read_to_string(&file).unwrap(), "# keep\nsessions = false\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_files_inherited_acl_stays_when_settings_change() {
        let dir = temp("windows-inherited-acl");
        let file = dir.join("config.toml");
        windows_script(
            &dir,
            r#"
            $a=[IO.Directory]::GetAccessControl($env:QUOTUM_TEST_FILE)
            $reader=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
            $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $reader,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
            [IO.Directory]::SetAccessControl($env:QUOTUM_TEST_FILE,$a)
        "#,
        );
        fs::write(&file, "sessions = true\n").unwrap();
        let before = windows_acl(&file, false);
        let next = dir.join("created.new");
        let temporary = create_private(&next, &file).unwrap();
        assert_eq!(temporary.metadata().unwrap().len(), 0);
        assert_eq!(windows_acl(&next, false), before, "exact ACEs and inheritance before writing any bytes");
        drop(temporary);
        fs::remove_file(next).unwrap();
        save(&file, &patch(r#"{"sessions":false}"#)).unwrap();
        assert_eq!(windows_acl(&file, false), before, "temporary protection must not change the final ACL");
        windows_script(
            &dir,
            r#"
            $a=[IO.Directory]::GetAccessControl($env:QUOTUM_TEST_FILE)
            $a.PurgeAccessRules([Security.Principal.SecurityIdentifier]::new('S-1-1-0'))
            [IO.Directory]::SetAccessControl($env:QUOTUM_TEST_FILE,$a)
        "#,
        );
        windows_script(
            &file,
            r#"
            $a=[IO.File]::GetAccessControl($env:QUOTUM_TEST_FILE)
            $remaining=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) |
                Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' })
            if($remaining.Count -ne 0) { throw 'revoked parent grant survived on the replacement' }
        "#,
        );
        assert_ne!(windows_acl(&file, false), before, "the inherited reader was revoked");
        fs::remove_dir_all(dir).unwrap();
    }
}
