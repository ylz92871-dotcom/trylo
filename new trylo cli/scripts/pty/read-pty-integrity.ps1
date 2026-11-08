param([Parameter(Mandatory = $true)][string]$ExecutablePath)
$ErrorActionPreference = 'Stop'

# LABEL_SECURITY_INFORMATION needs only READ_CONTROL. Declare this one native
# call in memory: Add-Type launches csc, which itself cannot start from some
# restricted build tokens. Reading a prepared file must not need a compiler.
$name = [Reflection.AssemblyName]::new('TryloPtyIntegrityReader')
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule($name.Name)
$native = $module.DefineType($name.Name, [Reflection.TypeAttributes]'Public, Sealed, Abstract')
$parameters = [type[]]@([string], [uint32], [byte[]], [uint32], [uint32].MakeByRefType())
$method = $native.DefinePInvokeMethod('GetFileSecurityW', 'advapi32.dll',
    [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
    [bool], $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
$import = [Runtime.InteropServices.DllImportAttribute]
$fields = [Reflection.FieldInfo[]]@($import.GetField('SetLastError'), $import.GetField('ExactSpelling'), $import.GetField('CharSet'))
$attribute = [Reflection.Emit.CustomAttributeBuilder]::new($import.GetConstructor([type[]]@([string])),
    [object[]]@('advapi32.dll'), $fields, [object[]]@($true, $true, [Runtime.InteropServices.CharSet]::Unicode))
$method.SetCustomAttribute($attribute)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
$query = $native.CreateType().GetMethod('GetFileSecurityW')

$path = (Get-Item -LiteralPath $ExecutablePath).FullName
$arguments = [object[]]@($path, [uint32]0x10, $null, [uint32]0, [uint32]0)
$null = $query.Invoke($null, $arguments)
$needed = [uint32]$arguments[4]
if ($needed -eq 0) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$descriptor = [byte[]]::new($needed)
$arguments = [object[]]@($path, [uint32]0x10, $descriptor, $needed, [uint32]0)
if (-not $query.Invoke($null, $arguments)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

# SECURITY_DESCRIPTOR_RELATIVE.Sacl; then ACL.AceCount and its mandatory ACEs.
$sacl = [BitConverter]::ToInt32($descriptor, 12)
$level = [int]::MaxValue
if ($sacl -ne 0) {
    $count = [BitConverter]::ToUInt16($descriptor, $sacl + 4)
    $offset = $sacl + 8
    for ($index = 0; $index -lt $count; $index++) {
        if ($descriptor[$offset] -eq 0x11) {
            $sid = [Security.Principal.SecurityIdentifier]::new($descriptor, $offset + 8)
            $level = [Math]::Min($level, [int]($sid.Value.Split('-')[-1]))
        }
        $offset += [BitConverter]::ToUInt16($descriptor, $offset + 2)
    }
}
if ($level -eq [int]::MaxValue) { $level = 8192 } # Unlabelled files are Medium.
Write-Output $level
