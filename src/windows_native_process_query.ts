// Candidate query only: callers retain their existing timeout and held-program safeguards.
// Some processes cannot be opened or can exit during enumeration; omitted rows do not
// establish that no process owns an executable.
export const WINDOWS_NATIVE_PROCESS_QUERY: string = `Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class CircleNativeProcessQuery
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const int ERROR_NO_MORE_FILES = 18;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void WriteProcess(uint processId)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return;
        try
        {
            StringBuilder image = new StringBuilder(32768);
            uint size = (uint)image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref size) || size == 0) return;
            string path = image.ToString();
            Console.WriteLine(processId.ToString(CultureInfo.InvariantCulture) + " " +
                Convert.ToBase64String(Encoding.UTF8.GetBytes(path)));
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static void WriteProcesses()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "process snapshot failed");
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NO_MORE_FILES) return;
                throw new Win32Exception(error, "first process snapshot entry failed");
            }
            while (true)
            {
                WriteProcess(entry.th32ProcessID);
                if (Process32Next(snapshot, ref entry)) continue;
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NO_MORE_FILES) break;
                throw new Win32Exception(error, "next process snapshot entry failed");
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@
[CircleNativeProcessQuery]::WriteProcesses()`;
