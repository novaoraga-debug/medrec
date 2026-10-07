using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

internal static class MedRecLauncher
{
    private static Process backend;
    private static Process frontend;
    private static StreamWriter backendLog;
    private static StreamWriter frontendLog;
    private static readonly object logLock = new object();
    private static int stopping;

    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (!File.Exists(Path.Combine(root, "package.json")) ||
            !File.Exists(Path.Combine(root, "backend", "src", "server.js")))
        {
            Console.Error.WriteLine("MedRec.exe must be in the MedRec project folder.");
            return 1;
        }

        if (args.Length > 0 && args[0] == "--check")
        {
            return CheckNode();
        }

        string logs = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MedRec", "logs");
        Directory.CreateDirectory(logs);
        backendLog = OpenLog(Path.Combine(logs, "backend.log"));
        frontendLog = OpenLog(Path.Combine(logs, "frontend.log"));

        try
        {
            if (!EnsureDependencies(root))
            {
                return 1;
            }

            if (IsHealthy("http://127.0.0.1:4000/api/health") ||
                IsHealthy("http://127.0.0.1:5173/"))
            {
                Console.Error.WriteLine("A MedRec service is already using a required local port.");
                Console.Error.WriteLine("Close the existing service and try again.");
                return 1;
            }

            var backendStart = NodeStartInfo(root, Path.Combine(root, "backend", "src", "server.js"));
            backendStart.EnvironmentVariables["HOST"] = "127.0.0.1";
            backendStart.EnvironmentVariables["PORT"] = "4000";
            backend = StartService(backendStart, backendLog);

            var frontendStart = NodeStartInfo(root, Path.Combine(root, "frontend", "node_modules", "vite", "bin", "vite.js"));
            frontendStart.WorkingDirectory = Path.Combine(root, "frontend");
            frontendStart.Arguments += " --host 127.0.0.1 --port 5173";
            frontend = StartService(frontendStart, frontendLog);

            Console.WriteLine("Starting MedRec locally...");
            if (!WaitForServices())
            {
                Console.Error.WriteLine("MedRec did not start. Check the logs in " + logs);
                return 1;
            }

            Console.WriteLine("MedRec is ready at http://127.0.0.1:5173");
            Console.WriteLine("Keep this window open while using MedRec. Press Ctrl+C to stop.");
            Process.Start(new ProcessStartInfo("http://127.0.0.1:5173") { UseShellExecute = true });

            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
            {
                eventArgs.Cancel = true;
                Interlocked.Exchange(ref stopping, 1);
            };

            while (Volatile.Read(ref stopping) == 0 &&
                   backend != null && frontend != null &&
                   !backend.HasExited && !frontend.HasExited)
            {
                Thread.Sleep(500);
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start MedRec: " + error.Message);
            Console.Error.WriteLine("If this is the first run, ensure Node.js and internet access are available.");
            return 1;
        }
        finally
        {
            StopService(frontend);
            StopService(backend);
            if (frontendLog != null) frontendLog.Dispose();
            if (backendLog != null) backendLog.Dispose();
        }
    }

    private static int CheckNode()
    {
        try
        {
            var start = new ProcessStartInfo("node", "--version");
            start.UseShellExecute = false;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (Process process = Process.Start(start))
            {
                string version = process.StandardOutput.ReadToEnd().Trim();
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException(process.StandardError.ReadToEnd());
                Console.WriteLine("Node.js " + version + " found.");
                return 0;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Node.js is required and must be on PATH: " + error.Message);
            return 1;
        }
    }

    private static bool EnsureDependencies(string root)
    {
        if (Directory.Exists(Path.Combine(root, "backend", "node_modules", "express")) &&
            File.Exists(Path.Combine(root, "frontend", "node_modules", "vite", "bin", "vite.js")))
        {
            return true;
        }

        Console.WriteLine("Installing MedRec dependencies (first run only)...");
        return RunNpm(root, "install --prefix backend") &&
               RunNpm(root, "install --prefix frontend");
    }

    private static bool RunNpm(string root, string arguments)
    {
        var start = new ProcessStartInfo("cmd.exe", "/d /c npm " + arguments);
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = false;
        using (Process process = Process.Start(start))
        {
            process.WaitForExit();
            if (process.ExitCode == 0) return true;
            Console.Error.WriteLine("Dependency installation failed (npm exit code " + process.ExitCode + ").");
            return false;
        }
    }

    private static ProcessStartInfo NodeStartInfo(string root, string script)
    {
        var start = new ProcessStartInfo("node", Quote(script));
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        return start;
    }

    private static Process StartService(ProcessStartInfo start, StreamWriter log)
    {
        var process = new Process();
        process.StartInfo = start;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            WriteLog(log, eventArgs.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            WriteLog(log, eventArgs.Data);
        };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static bool WaitForServices()
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            if (backend.HasExited || frontend.HasExited) return false;
            if (IsHealthy("http://127.0.0.1:4000/api/health") &&
                IsHealthy("http://127.0.0.1:5173/"))
            {
                return true;
            }
            Thread.Sleep(500);
        }
        return false;
    }

    private static bool IsHealthy(string url)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Proxy = null;
            request.Timeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch
        {
            return false;
        }
    }

    private static StreamWriter OpenLog(string path)
    {
        return new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite));
    }

    private static void WriteLog(StreamWriter log, string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            log.WriteLine(line);
            log.Flush();
        }
    }

    private static void StopService(Process process)
    {
        if (process == null) return;
        try
        {
            if (!process.HasExited) process.Kill();
            process.WaitForExit(5000);
        }
        catch { }
        process.Dispose();
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
