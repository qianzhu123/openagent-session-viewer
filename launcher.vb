' OpenAgent Session Viewer - launcher (VB.NET, silent, no console window)
' Equivalent to the original start.vbs: silently calls start.bat quiet in the same folder.
' Build: vbc /target:winexe /win32icon:app.ico /out:openagent-session-viewer.exe launcher.vb

Imports System
Imports System.IO
Imports System.Diagnostics

Module Launcher
    Sub Main()
        Try
            Dim projectDir As String = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location)
            Dim batPath As String = Path.Combine(projectDir, "start.bat")
            Dim psi As New ProcessStartInfo()
            psi.FileName = "cmd.exe"
            psi.Arguments = "/c """ & batPath & """ quiet"
            psi.UseShellExecute = False
            psi.CreateNoWindow = True
            psi.WindowStyle = ProcessWindowStyle.Hidden
            psi.WorkingDirectory = projectDir
            Process.Start(psi)
        Catch ex As Exception
            ' Silent: write the failure to data\start_err.log
            Try
                Dim projectDir As String = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location)
                Dim errPath As String = Path.Combine(projectDir, "data", "start_err.log")
                Directory.CreateDirectory(Path.Combine(projectDir, "data"))
                File.AppendAllText(errPath, "[launcher] " & ex.Message & Environment.NewLine)
            Catch
            End Try
        End Try
    End Sub
End Module
