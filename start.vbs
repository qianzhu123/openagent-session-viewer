' OpenAgent Session Viewer - Windows 双击启动器(VBS,静默无控制台窗口)
' 仅负责静默调用 start.bat;所有探测/启动逻辑放在 start.bat 里,避免 VBScript 转义地雷。
' 这样 VBS 极简、可靠,出错也能在 bat 侧 pause 留窗。

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
' 静默调用 start.bat quiet —— bat 失败写入 data\start_err.log(bat 侧已无 pause 不卡)
shell.Run "cmd /c """ & projectDir & "\start.bat"" quiet", 0, False
Set shell = Nothing
Set fso = Nothing
