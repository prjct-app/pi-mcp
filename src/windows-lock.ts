import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

export type WindowsAclRunner = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;
const execute = promisify(execFile);
const runAcl: WindowsAclRunner = (command, args, env) => execute(command, args, { env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 });

// The path is passed in the child environment, never interpolated into code.
// A new directory needs an explicit DACL: Node's mkdir mode is ignored on Windows.
// Existing directories with foreign grants, a null DACL, or deny rules fail closed.
// Use the fixed Windows PowerShell's .NET Framework APIs directly: an inherited
// PowerShell 7 PSModulePath can otherwise load incompatible Get-Acl/Set-Acl modules.
const PRIVATE_ACL = `
$ErrorActionPreference = 'Stop'
$path = $env:PI_MCP_LOCK_DIRECTORY
$attributes = [IO.File]::GetAttributes($path)
if (-not ($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe directory' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [IO.Directory]::GetAccessControl($path)
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($owner -ne $sid.Value -and $owner -ne 'S-1-5-32-544') { throw 'Untrusted owner' }
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Unsupported deny rule' }
  if ($env:PI_MCP_LOCK_CREATED -ne '1' -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'Foreign access grant' }
}
if ($env:PI_MCP_LOCK_CREATED -ne '1') {
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Null DACL' }
}
$private = [Security.AccessControl.DirectorySecurity]::new()
$private.SetOwner($sid)
$private.SetAccessRuleProtection($true, $false)
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$private.SetAccessRule($rule)
[IO.Directory]::SetAccessControl($path, $private)
$attributes = [IO.File]::GetAttributes($path)
$verified = [IO.Directory]::GetAccessControl($path)
if (-not ($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'ACL verification failed' }
$granted = $false
foreach ($rule in $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Unexpected access rule' }
  if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $granted = $true }
}
if (-not $granted) { throw 'Owner access was not verified' }
'private'
`;

/** @internal Secure the dedicated lock directory using Windows ACLs, not POSIX mode bits. */
export async function ensureWindowsPrivateLockDirectory(root: string, created: boolean, run: WindowsAclRunner = runAcl): Promise<void> {
  try {
    const command = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRIVATE_ACL], {
      ...process.env, PI_MCP_LOCK_DIRECTORY: root, PI_MCP_LOCK_CREATED: created ? '1' : '0',
    });
    if (stdout.trim() !== 'private') throw new Error('ACL verification did not complete');
  } catch {
    throw new Error('MCP credential lock directory requires a private Windows ACL owned by this user. No unsafe lock was used.');
  }
}
