' OpenAgent Session Viewer - Windows double-click launcher (VBS, silent, no console window).
' Only silently invokes start.bat; all detection/startup logic lives in start.bat
' to avoid VBScript escape pitfalls. This keeps the VBS minimal and reliable,
' and failures still pause in the BAT side when not quiet.

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
' Silently call start.bat quiet -- BAT writes failures to data\start_err.log (no pause in quiet mode).
shell.Run "cmd /c """ & projectDir & "\start.bat"" quiet", 0, False
Set shell = Nothing
Set fso = Nothing
