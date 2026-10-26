using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace StartupHealth
{
    public static class Jsonc
    {
        public static string NormalizeAndRejectDuplicateProperties(string input)
        {
            if (input == null) throw new ArgumentNullException("input");
            var normalized = StripCommentsAndTrailingCommas(input);
            var parser = new DuplicatePropertyParser(normalized);
            parser.Parse();
            return normalized;
        }

        private static string StripCommentsAndTrailingCommas(string input)
        {
            var output = new StringBuilder(input.Length);
            var inString = false;
            var escaped = false;
            for (var index = 0; index < input.Length; index++)
            {
                var current = input[index];
                if (inString)
                {
                    output.Append(current);
                    if (escaped) escaped = false;
                    else if (current == '\\') escaped = true;
                    else if (current == '"') inString = false;
                    continue;
                }
                if (current == '"') { inString = true; output.Append(current); continue; }
                if (current == '/' && index + 1 < input.Length && input[index + 1] == '/')
                {
                    output.Append(' '); output.Append(' '); index += 2;
                    while (index < input.Length && input[index] != '\r' && input[index] != '\n') { output.Append(' '); index++; }
                    if (index < input.Length) output.Append(input[index]);
                    continue;
                }
                if (current == '/' && index + 1 < input.Length && input[index + 1] == '*')
                {
                    output.Append(' '); output.Append(' '); index += 2;
                    var closed = false;
                    while (index < input.Length)
                    {
                        if (index + 1 < input.Length && input[index] == '*' && input[index + 1] == '/')
                        {
                            output.Append(' '); output.Append(' '); index++; closed = true; break;
                        }
                        output.Append(input[index] == '\r' || input[index] == '\n' ? input[index] : ' ');
                        index++;
                    }
                    if (!closed) throw new FormatException("Unterminated JSONC block comment.");
                    continue;
                }
                if (current == ',')
                {
                    var lookahead = index + 1;
                    while (lookahead < input.Length && Char.IsWhiteSpace(input[lookahead])) lookahead++;
                    if (lookahead < input.Length && (input[lookahead] == '}' || input[lookahead] == ']')) { output.Append(' '); continue; }
                }
                output.Append(current);
            }
            if (inString) throw new FormatException("Unterminated JSON string.");
            return RemoveTrailingCommas(output.ToString());
        }

        private static string RemoveTrailingCommas(string input)
        {
            var output = new StringBuilder(input);
            var inString = false;
            var escaped = false;
            for (var index = 0; index < output.Length; index++)
            {
                var current = output[index];
                if (inString)
                {
                    if (escaped) escaped = false;
                    else if (current == '\\') escaped = true;
                    else if (current == '"') inString = false;
                    continue;
                }
                if (current == '"') { inString = true; continue; }
                if (current != ',') continue;
                var lookahead = index + 1;
                while (lookahead < output.Length && Char.IsWhiteSpace(output[lookahead])) lookahead++;
                if (lookahead < output.Length && (output[lookahead] == '}' || output[lookahead] == ']')) output[index] = ' ';
            }
            return output.ToString();
        }

        private sealed class DuplicatePropertyParser
        {
            private readonly string text;
            private int index;

            internal DuplicatePropertyParser(string text) { this.text = text; }

            internal void Parse()
            {
                SkipWhitespace();
                ParseValue();
                SkipWhitespace();
                if (index != text.Length) throw new FormatException("Unexpected content after JSON value.");
            }

            private void ParseValue()
            {
                SkipWhitespace();
                if (index >= text.Length) throw new FormatException("Missing JSON value.");
                if (text[index] == '{') { ParseObject(); return; }
                if (text[index] == '[') { ParseArray(); return; }
                if (text[index] == '"') { ReadString(); return; }
                var start = index;
                while (index < text.Length && !Char.IsWhiteSpace(text[index]) && text[index] != ',' && text[index] != ']' && text[index] != '}') index++;
                if (index == start) throw new FormatException("Invalid JSON value.");
            }

            private void ParseObject()
            {
                index++;
                var names = new HashSet<string>(StringComparer.Ordinal);
                SkipWhitespace();
                if (Consume('}')) return;
                while (true)
                {
                    SkipWhitespace();
                    if (index >= text.Length || text[index] != '"') throw new FormatException("JSON object property name is missing.");
                    var name = ReadString();
                    if (!names.Add(name)) throw new FormatException("Duplicate JSON property: " + name);
                    SkipWhitespace();
                    if (!Consume(':')) throw new FormatException("JSON object property separator is missing.");
                    ParseValue();
                    SkipWhitespace();
                    if (Consume('}')) return;
                    if (!Consume(',')) throw new FormatException("JSON object delimiter is invalid.");
                }
            }

            private void ParseArray()
            {
                index++;
                SkipWhitespace();
                if (Consume(']')) return;
                while (true)
                {
                    ParseValue();
                    SkipWhitespace();
                    if (Consume(']')) return;
                    if (!Consume(',')) throw new FormatException("JSON array delimiter is invalid.");
                }
            }

            private string ReadString()
            {
                if (!Consume('"')) throw new FormatException("JSON string is missing.");
                var value = new StringBuilder();
                while (index < text.Length)
                {
                    var current = text[index++];
                    if (current == '"') return value.ToString();
                    if (current != '\\') { value.Append(current); continue; }
                    if (index >= text.Length) throw new FormatException("JSON string escape is truncated.");
                    var escaped = text[index++];
                    switch (escaped)
                    {
                        case '"': value.Append('"'); break;
                        case '\\': value.Append('\\'); break;
                        case '/': value.Append('/'); break;
                        case 'b': value.Append('\b'); break;
                        case 'f': value.Append('\f'); break;
                        case 'n': value.Append('\n'); break;
                        case 'r': value.Append('\r'); break;
                        case 't': value.Append('\t'); break;
                        case 'u':
                            if (index + 4 > text.Length) throw new FormatException("JSON unicode escape is truncated.");
                            int code;
                            if (!Int32.TryParse(text.Substring(index, 4), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out code))
                                throw new FormatException("JSON unicode escape is invalid.");
                            value.Append((char)code); index += 4; break;
                        default: throw new FormatException("JSON string escape is invalid.");
                    }
                }
                throw new FormatException("Unterminated JSON string.");
            }

            private bool Consume(char expected)
            {
                if (index < text.Length && text[index] == expected) { index++; return true; }
                return false;
            }

            private void SkipWhitespace() { while (index < text.Length && Char.IsWhiteSpace(text[index])) index++; }
        }
    }

    public sealed class ProcessAncestor
    {
        public int ProcessId { get; internal set; }
        public int ParentProcessId { get; internal set; }
        public string ExecutablePath { get; internal set; }
        public string ProcessStartFileTime { get; internal set; }
    }

    public sealed class FileIdentity
    {
        public string CanonicalPath { get; internal set; }
        public long Length { get; internal set; }
        public long LastWriteUtcTicks { get; internal set; }
        public uint VolumeSerialNumber { get; internal set; }
        public ulong FileIndex { get; internal set; }
        public string FileVersion { get; internal set; }
    }

    public static class RuntimeIdentity
    {
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint TOKEN_QUERY = 0x0008;
        private const uint TOKEN_DUPLICATE = 0x0002;
        private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        private const uint GROUP_SECURITY_INFORMATION = 0x00000002;
        private const uint DACL_SECURITY_INFORMATION = 0x00000004;
        private const int SE_FILE_OBJECT = 1;
        private const int SecurityImpersonation = 2;
        private const uint FILE_ADD_FILE = 0x00000002;
        private const uint FILE_DELETE_CHILD = 0x00000040;
        private const uint FILE_WRITE_ATTRIBUTES = 0x00000100;

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public FILETIME CreationTime;
            public FILETIME LastAccessTime;
            public FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct GENERIC_MAPPING
        {
            public uint GenericRead;
            public uint GenericWrite;
            public uint GenericExecute;
            public uint GenericAll;
        }

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(IntPtr process, int processInformationClass, ref PROCESS_BASIC_INFORMATION information, int length, out int returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFile(string fileName, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetNamedSecurityInfo(string objectName, int objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateToken(IntPtr existingToken, int impersonationLevel, out IntPtr duplicateToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern void MapGenericMask(ref uint accessMask, ref GENERIC_MAPPING mapping);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool AccessCheck(IntPtr securityDescriptor, IntPtr clientToken, uint desiredAccess, ref GENERIC_MAPPING mapping, IntPtr privilegeSet, ref uint privilegeSetLength, out uint grantedAccess, out bool accessStatus);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static ProcessAncestor ReadProcess(int processId)
        {
            var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var basic = new PROCESS_BASIC_INFORMATION();
                int returned;
                var status = NtQueryInformationProcess(handle, 0, ref basic, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned);
                if (status != 0) throw new Win32Exception(status);
                var capacity = 32768;
                var path = new StringBuilder(capacity);
                if (!QueryFullProcessImageName(handle, 0, path, ref capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
                FILETIME creation, exit, kernel, user;
                if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var start = ((ulong)creation.HighDateTime << 32) | creation.LowDateTime;
                return new ProcessAncestor
                {
                    ProcessId = processId,
                    ParentProcessId = basic.InheritedFromUniqueProcessId.ToInt32(),
                    ExecutablePath = path.ToString(),
                    ProcessStartFileTime = start.ToString(),
                };
            }
            finally { CloseHandle(handle); }
        }

        public static ProcessAncestor[] GetAncestors(int startingProcessId, int maximumDepth)
        {
            if (startingProcessId <= 0 || maximumDepth <= 0 || maximumDepth > 32) throw new ArgumentOutOfRangeException();
            var result = new List<ProcessAncestor>();
            var current = startingProcessId;
            var seen = new HashSet<int>();
            for (var depth = 0; depth < maximumDepth && current > 0 && seen.Add(current); depth++)
            {
                ProcessAncestor item;
                try { item = ReadProcess(current); }
                catch { if (depth == 0) throw; else break; }
                result.Add(item);
                current = item.ParentProcessId;
            }
            return result.ToArray();
        }

        public static ProcessAncestor GetProcess(int processId)
        {
            return ReadProcess(processId);
        }

        public static FileIdentity GetFileIdentity(string path)
        {
            var canonical = Path.GetFullPath(path);
            var handle = CreateFile(canonical, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                BY_HANDLE_FILE_INFORMATION native;
                if (!GetFileInformationByHandle(handle, out native)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var info = new FileInfo(canonical);
                return new FileIdentity
                {
                    CanonicalPath = info.FullName,
                    Length = info.Length,
                    LastWriteUtcTicks = info.LastWriteTimeUtc.Ticks,
                    VolumeSerialNumber = native.VolumeSerialNumber,
                    FileIndex = ((ulong)native.FileIndexHigh << 32) | native.FileIndexLow,
                    FileVersion = FileVersionInfo.GetVersionInfo(info.FullName).FileVersion ?? string.Empty,
                };
            }
            finally { CloseHandle(handle); }
        }

        public static bool CanCreateWriteDeleteChild(string directoryPath)
        {
            var canonical = Path.GetFullPath(directoryPath);
            IntPtr owner, group, dacl, sacl, descriptor;
            var error = GetNamedSecurityInfo(canonical, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error);
            IntPtr token = IntPtr.Zero, duplicate = IntPtr.Zero, privileges = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!DuplicateToken(token, SecurityImpersonation, out duplicate)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var mapping = new GENERIC_MAPPING { GenericRead = 0x00120089, GenericWrite = 0x00120116, GenericExecute = 0x001200A0, GenericAll = 0x001F01FF };
                var desired = FILE_ADD_FILE | FILE_DELETE_CHILD | FILE_WRITE_ATTRIBUTES;
                MapGenericMask(ref desired, ref mapping);
                uint privilegeLength = 4096;
                privileges = Marshal.AllocHGlobal((int)privilegeLength);
                uint granted;
                bool allowed;
                if (!AccessCheck(descriptor, duplicate, desired, ref mapping, privileges, ref privilegeLength, out granted, out allowed)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return allowed && (granted & desired) == desired;
            }
            finally
            {
                if (privileges != IntPtr.Zero) Marshal.FreeHGlobal(privileges);
                if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }
    }

    public sealed class ProcessResult
    {
        public int? ExitCode { get; internal set; }
        public bool TimedOut { get; internal set; }
        public string Stdout { get; internal set; }
        public string Stderr { get; internal set; }
        public bool StdoutTruncated { get; internal set; }
        public bool StderrTruncated { get; internal set; }
        public long DurationMilliseconds { get; internal set; }
    }

    public sealed class ProcessRequest
    {
        public string Key { get; set; }
        public string Executable { get; set; }
        public string[] Arguments { get; set; }
        public string WorkingDirectory { get; set; }
        public int TimeoutMilliseconds { get; set; }
        public int MaximumBytes { get; set; }
    }

    public sealed class ProcessBatchItem
    {
        public string Key { get; internal set; }
        public ProcessResult Result { get; internal set; }
        public bool AggregateTimedOut { get; internal set; }
        public string Error { get; internal set; }
    }

    public static class IsolatedProcess
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFile(string fileName, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);

        private sealed class Capture
        {
            public string Text;
            public bool Truncated;
        }

        private static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            var result = new StringBuilder("\"");
            var slashes = 0;
            foreach (var character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    result.Append('\\', slashes * 2 + 1).Append(character);
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes).Append(character);
                slashes = 0;
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }

        private static string CommandLine(string executable, string[] arguments)
        {
            var parts = new List<string> { Quote(executable) };
            foreach (var argument in arguments ?? new string[0]) parts.Add(Quote(argument ?? string.Empty));
            return string.Join(" ", parts.ToArray());
        }

        private static Task<Capture> Drain(IntPtr handle, int maximumBytes)
        {
            return Task.Run(() =>
            {
                using (var safe = new SafeFileHandle(handle, true))
                using (var stream = new FileStream(safe, FileAccess.Read, 4096, false))
                using (var kept = new MemoryStream())
                {
                    var buffer = new byte[4096];
                    var truncated = false;
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        var remaining = Math.Max(0, maximumBytes - (int)kept.Length);
                        var count = Math.Min(remaining, read);
                        if (count > 0) kept.Write(buffer, 0, count);
                        if (count < read) truncated = true;
                    }
                    return new Capture { Text = new UTF8Encoding(false, false).GetString(kept.ToArray()), Truncated = truncated };
                }
            });
        }

        public static ProcessResult Run(string executable, string[] arguments, string workingDirectory, int timeoutMilliseconds, int maximumBytes)
        {
            if (string.IsNullOrWhiteSpace(executable) || !Path.IsPathRooted(executable)) throw new ArgumentException("Executable must be absolute.");
            if (timeoutMilliseconds <= 0) throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            if (maximumBytes <= 0) throw new ArgumentOutOfRangeException("maximumBytes");
            var stopwatch = Stopwatch.StartNew();
            IntPtr job = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, nullInput = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            var processCreated = false;
            try
            {
                var inheritable = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
                if (!CreatePipe(out stdoutRead, out stdoutWrite, ref inheritable, 0) || !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!CreatePipe(out stderrRead, out stderrWrite, ref inheritable, 0) || !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
                nullInput = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                if (nullInput == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                var pointer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(limits, pointer, false);
                    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                finally { Marshal.FreeHGlobal(pointer); }

                var startup = new STARTUPINFO
                {
                    cb = Marshal.SizeOf(typeof(STARTUPINFO)),
                    dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = nullInput,
                    hStdOutput = stdoutWrite,
                    hStdError = stderrWrite,
                };
                var commandLine = new StringBuilder(CommandLine(executable, arguments));
                if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, workingDirectory, ref startup, out process))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                processCreated = true;
                if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error());

                CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
                CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;
                CloseHandle(nullInput); nullInput = IntPtr.Zero;
                var stdoutTask = Drain(stdoutRead, maximumBytes); stdoutRead = IntPtr.Zero;
                var stderrTask = Drain(stderrRead, maximumBytes); stderrRead = IntPtr.Zero;
                if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                CloseHandle(process.hThread); process.hThread = IntPtr.Zero;

                var wait = WaitForSingleObject(process.hProcess, (uint)timeoutMilliseconds);
                var timedOut = wait == 0x00000102;
                if (wait != 0 && !timedOut) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (timedOut)
                {
                    TerminateJobObject(job, 1460);
                    WaitForSingleObject(process.hProcess, 5000);
                }
                uint exitCode;
                int? code = GetExitCodeProcess(process.hProcess, out exitCode) ? (int?)unchecked((int)exitCode) : null;
                Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 5000);
                var stdout = stdoutTask.IsCompleted ? stdoutTask.Result : new Capture { Text = string.Empty, Truncated = true };
                var stderr = stderrTask.IsCompleted ? stderrTask.Result : new Capture { Text = string.Empty, Truncated = true };
                return new ProcessResult
                {
                    ExitCode = code,
                    TimedOut = timedOut,
                    Stdout = stdout.Text,
                    Stderr = stderr.Text,
                    StdoutTruncated = stdout.Truncated,
                    StderrTruncated = stderr.Truncated,
                    DurationMilliseconds = stopwatch.ElapsedMilliseconds,
                };
            }
            finally
            {
                if (job != IntPtr.Zero) CloseHandle(job);
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (processCreated && process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead);
                if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite);
                if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead);
                if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite);
                if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
            }
        }

        public static ProcessBatchItem[] RunBatch(ProcessRequest[] requests, int maximumConcurrency, int aggregateMilliseconds)
        {
            if (requests == null) throw new ArgumentNullException("requests");
            if (maximumConcurrency <= 0 || maximumConcurrency > 32) throw new ArgumentOutOfRangeException("maximumConcurrency");
            if (aggregateMilliseconds <= 0) throw new ArgumentOutOfRangeException("aggregateMilliseconds");
            var results = new ProcessBatchItem[requests.Length];
            var next = -1;
            var stopwatch = Stopwatch.StartNew();
            var workerCount = Math.Min(maximumConcurrency, requests.Length);
            var workers = new Task[workerCount];
            for (var worker = 0; worker < workerCount; worker++)
            {
                workers[worker] = Task.Run(() =>
                {
                    while (true)
                    {
                        var index = System.Threading.Interlocked.Increment(ref next);
                        if (index >= requests.Length) return;
                        var request = requests[index];
                        var remaining = aggregateMilliseconds - (int)Math.Min(Int32.MaxValue, stopwatch.ElapsedMilliseconds);
                        if (remaining <= 0)
                        {
                            results[index] = new ProcessBatchItem { Key = request.Key, AggregateTimedOut = true };
                            continue;
                        }
                        try
                        {
                            var timeout = Math.Min(request.TimeoutMilliseconds, remaining);
                            results[index] = new ProcessBatchItem
                            {
                                Key = request.Key,
                                Result = Run(request.Executable, request.Arguments, request.WorkingDirectory, timeout, request.MaximumBytes),
                            };
                        }
                        catch (Exception error)
                        {
                            results[index] = new ProcessBatchItem { Key = request.Key, Error = error.GetType().Name };
                        }
                    }
                });
            }
            Task.WaitAll(workers);
            return results;
        }
    }
}
