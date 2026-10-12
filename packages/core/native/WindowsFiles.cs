using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
public static class SourcePropertyCommit {
  public static long BytesRead;
  public static double PublishedMtime;
  public static void EnsureDirectory(string vault, string relative) {
    BytesRead=0; PublishedMtime=0;
    if(relative==null || relative.StartsWith("/") || relative.IndexOf('\\')>=0 || relative.IndexOf(':')>=0) throw new IOException("Invalid task directory");
    var handles=new List<SafeFileHandle>();
    try {
      string full=Path.GetFullPath(vault), current=Path.GetPathRoot(full);
      if(current.Length!=3 || current[1]!=':') throw new IOException("Local volume required");
      handles.Add(Open(current,true,false,true));
      foreach(string segment in full.Substring(current.Length).Split(new char[]{Path.DirectorySeparatorChar},StringSplitOptions.RemoveEmptyEntries)) {
        current=Path.Combine(current,segment); handles.Add(Open(current,true,false,!String.Equals(current,full,StringComparison.OrdinalIgnoreCase)));
      }
      foreach(string segment in relative.Split('/')) {
        if(segment.Length==0 || segment=="." || segment==".." || segment.EndsWith(".") || segment.EndsWith(" ")) throw new IOException("Invalid task segment");
        current=Path.Combine(current,segment);
        if(!Directory.Exists(current)) Directory.CreateDirectory(current);
        handles.Add(Open(current,true));
      }
    } finally { for(int i=handles.Count-1;i>=0;i--) handles[i].Dispose(); }
  }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, IntPtr data, uint length);
  static SafeFileHandle Open(string p, bool directory, bool captureLinks=false, bool allowHidden=false) {
    var h = CreateFileW(p, directory ? 0x80u : 0x80010000u, directory ? 3u : 1u, IntPtr.Zero, 3, directory ? 0x02200000u : 0x00200000u, IntPtr.Zero);
    if(h.IsInvalid) { h.Dispose(); throw new IOException("Locked or unavailable path"); }
    Info i;
    if(!GetFileInformationByHandle(h, out i) || (i.Attributes & 0x400) != 0 || (!allowHidden && (i.Attributes & 2) != 0) || ((i.Attributes & 0x10) != 0) != directory || (!directory && ((i.Attributes & 1) != 0 || (i.Links!=1 && (!captureLinks || !SafeLinks(p,i))) || i.SizeHigh != 0 || i.SizeLow > 5242880))) {
      h.Dispose(); throw new IOException("Unsafe file identity");
    }
    return h;
  }
  static bool SafeLinks(string p, Info original) {
    if(original.Links==1) return true;
    uint known=1;
    // A killed Capture publisher may leave its own hard-link temporary name. Retain that
    // original inode while replacing only the Record name; arbitrary aliases remain refused.
    foreach(string candidate in Directory.GetFiles(Path.GetDirectoryName(p),".engramweave-capture-*.tmp")) {
      if(!Regex.IsMatch(Path.GetFileName(candidate),@"^\.engramweave-capture-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$")) continue;
      using(var h=CreateFileW(candidate,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
        Info i;
        if(!h.IsInvalid && GetFileInformationByHandle(h,out i) && (i.Attributes & 0x400)==0 && i.Volume==original.Volume && i.IndexHigh==original.IndexHigh && i.IndexLow==original.IndexLow) known++;
      }
    }
    return known==original.Links;
  }
  static string Hash(SafeFileHandle h, int limit=5242880) {
    // The stream owns this handle; duplicate ownership is avoided by disposing it only at the caller.
    using(var s = new FileStream(new SafeFileHandle(h.DangerousGetHandle(), false), FileAccess.Read))
    using(var sha = SHA256.Create()) { if(s.Length>limit) throw new IOException("Artifact too large"); BytesRead+=s.Length; return BitConverter.ToString(sha.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }
  }
  static void Move(SafeFileHandle h, string target) {
    byte[] name = System.Text.Encoding.Unicode.GetBytes(target);
    int offset = IntPtr.Size == 8 ? 20 : 12;
    IntPtr data = Marshal.AllocHGlobal(offset + name.Length + 2);
    try {
      for(int i=0;i<offset;i++) Marshal.WriteByte(data,i,0);
      Marshal.WriteInt32(data, IntPtr.Size == 8 ? 16 : 8, name.Length);
      Marshal.Copy(name,0,IntPtr.Add(data,offset),name.Length);
      Marshal.WriteInt16(data,offset+name.Length,0);
      if(!SetFileInformationByHandle(h,3,data,(uint)(offset+name.Length+2))) throw new IOException("Rename refused");
    } finally { Marshal.FreeHGlobal(data); }
  }
  static void Remove(SafeFileHandle h) {
    IntPtr data = Marshal.AllocHGlobal(4);
    try { Marshal.WriteInt32(data,1); if(!SetFileInformationByHandle(h,4,data,4)) throw new IOException("Cleanup refused"); }
    finally { Marshal.FreeHGlobal(data); }
  }
  static void RemoveChecked(string p, string hash, bool captureLinks=false) {
    if(!File.Exists(p)) return;
    using(var h=Open(p,false,captureLinks)) { if(Hash(h)!=hash) throw new IOException("Artifact changed"); Remove(h); }
  }
  static void Create(string p, string encoded, int limit) {
    byte[] bytes=Convert.FromBase64String(encoded);
    if(bytes.Length>limit) throw new IOException("Artifact too large");
    using(var stream=new FileStream(p,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
      stream.Write(bytes,0,bytes.Length); stream.Flush(true);
    }
  }
  public static void Run(string vault, string relative, string stem, string oldHash, string newHash, string manifestHash, bool recover, string manifestBytes, string replacementBytes, bool delete) {
    BytesRead=0; PublishedMtime=0;
    var directories = new List<SafeFileHandle>();
    try {
      string fullVault=Path.GetFullPath(vault), current=Path.GetPathRoot(fullVault);
      if(current.Length!=3 || current[1]!=':') throw new IOException("Local volume required");
      directories.Add(Open(current,true,false,true));
      string[] ancestors=fullVault.Substring(current.Length).Split(new char[]{Path.DirectorySeparatorChar},StringSplitOptions.RemoveEmptyEntries);
      foreach(string segment in ancestors) {
        current=Path.Combine(current,segment);
        directories.Add(Open(current,true,false,!String.Equals(current,fullVault,StringComparison.OrdinalIgnoreCase)));
      }
      string[] parts = relative.Split('/');
      for(int i=0;i<parts.Length-1;i++) { current=Path.Combine(current,parts[i]); directories.Add(Open(current,true)); }
      string target=Path.Combine(current,parts[parts.Length-1]), temp=Path.Combine(current,stem+".tmp"), backup=Path.Combine(current,stem+".bak");
      using(var original=recover ? null : Open(target,false,!delete)) {
      if(delete) { if(Hash(original)!=oldHash) throw new IOException("Revision conflict"); Remove(original); return; }
      if(!recover) {
        if(Hash(original)!=oldHash) throw new IOException("Revision conflict");
        Create(Path.Combine(current,stem+".json"),manifestBytes,4096);
        Create(temp,replacementBytes,5242880);
      }
      using(var manifest=Open(Path.Combine(current,stem+".json"),false)) {
      if(Hash(manifest,4096)!=manifestHash) throw new IOException("Manifest changed");
      if(recover) {
        if(File.Exists(target)) {
          using(var h=Open(target,false,true)) {
            string actual=Hash(h);
            if(actual!=oldHash && actual!=newHash) throw new IOException("Recovery conflicts with current file");
            RemoveChecked(backup,oldHash,true); RemoveChecked(temp,newHash);
          }
        } else {
          using(var h=Open(backup,false,true)) { if(Hash(h)!=oldHash) throw new IOException("Backup changed"); Move(h,target); }
          RemoveChecked(temp,newHash);
        }
      } else {
        using(var replacement=Open(temp,false)) {
          if(Hash(replacement)!=newHash) throw new IOException("Replacement changed");
          Move(original,backup);
          Move(replacement,target);
          Info published;
          if(!GetFileInformationByHandle(replacement,out published)) throw new IOException("Published identity unavailable");
          long written=((long)published.Write.dwHighDateTime<<32)|(uint)published.Write.dwLowDateTime;
          PublishedMtime=(DateTime.FromFileTimeUtc(written)-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
          Remove(original);
        }
      }
      Remove(manifest);
      }
      }
    } finally { for(int i=directories.Count-1;i>=0;i--) directories[i].Dispose(); }
  }
}
public static class Program {
  // Notifications are bounded hints. Core verifies paths and bytes before publishing anything.
  static void Watch(System.Web.Script.Serialization.JavaScriptSerializer json) {
    var pending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var gate = new object(); string lost = null;
    string first = Console.ReadLine();
    try {
      var input = json.Deserialize<Dictionary<string, object>>(first);
      string root = Path.GetFullPath(Text(input,"vault"));
      if(!Directory.Exists(root) || (File.GetAttributes(root) & (FileAttributes.ReparsePoint | FileAttributes.Hidden)) != 0) throw new IOException();
      using(var watcher = new FileSystemWatcher(root)) {
        watcher.IncludeSubdirectories = true; watcher.InternalBufferSize = 32768;
        watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Attributes | NotifyFilters.CreationTime | NotifyFilters.Security;
        Action<string> changed = delegate(string name) {
          if(String.IsNullOrEmpty(name)) { lock(gate) lost="watcher_unknown_event"; return; }
          if(name.StartsWith(".") || name.StartsWith("~")) return;
          lock(gate) {
            if(pending.Count >= 10000 || name.Length > 32768) { pending.Clear(); lost="watcher_overflow"; }
            else pending.Add(name.Replace('\\','/'));
          }
        };
        watcher.Changed += delegate(object sender, FileSystemEventArgs e) { changed(e.Name); };
        watcher.Created += delegate(object sender, FileSystemEventArgs e) { changed(e.Name); };
        watcher.Deleted += delegate(object sender, FileSystemEventArgs e) { changed(e.Name); };
        watcher.Renamed += delegate(object sender, RenamedEventArgs e) { changed(e.OldName); changed(e.Name); };
        watcher.Error += delegate(object sender, ErrorEventArgs e) { lock(gate) { pending.Clear(); lost=e.GetException() is InternalBufferOverflowException ? "watcher_overflow" : "watcher_error"; } };
        watcher.EnableRaisingEvents = true;
        Console.WriteLine("{\"ready\":true}");
        string command;
        while((command=Console.ReadLine()) != null) {
          if(command != "drain") throw new IOException();
          // Let already queued notification callbacks settle after an immediate save -> Refresh.
          System.Threading.Thread.Sleep(30);
          lock(gate) { Console.WriteLine(json.Serialize(new { paths=new List<string>(pending), lost=lost })); pending.Clear(); lost=null; }
        }
      }
    } catch { Console.WriteLine("{\"ready\":false}"); }
  }
  static string Text(Dictionary<string, object> request, string key) {
    object value;
    return request.TryGetValue(key, out value) && value is string ? (string)value : null;
  }
  static bool Flag(Dictionary<string, object> request, string key) {
    object value;
    return request.TryGetValue(key, out value) && value is bool && (bool)value;
  }
  public static void Main(string[] args) {
    Console.InputEncoding = new System.Text.UTF8Encoding(false);
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    var json = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = 16000000, RecursionLimit = 32 };
    if(args.Length == 1 && args[0] == "watch") { Watch(json); return; }
    if(args.Length != 1 || (args[0] != "attributes" && args[0] != "commit")) return;
    string line;
    while((line = Console.ReadLine()) != null) {
      SourcePropertyCommit.BytesRead=0;
      try {
        if(line.Length > 16000000) throw new IOException("Request too large");
        if(args[0] == "attributes") {
          var paths = json.Deserialize<string[]>(line);
          if(paths.Length > 512) throw new IOException("Attribute request too large");
          var values = new List<object>();
          foreach(string p in paths) {
            var attrs = File.GetAttributes(p);
            values.Add(new { path=p, reparse=(attrs & FileAttributes.ReparsePoint)!=0, hidden=(attrs & FileAttributes.Hidden)!=0 });
          }
          Console.WriteLine(json.Serialize(values));
        } else {
          var r = json.Deserialize<Dictionary<string, object>>(line);
          if(Flag(r,"mkdir")) SourcePropertyCommit.EnsureDirectory(Text(r,"vault"),Text(r,"relative"));
          else SourcePropertyCommit.Run(Text(r,"vault"),Text(r,"relative"),Text(r,"stem"),Text(r,"before"),Text(r,"after"),Text(r,"manifest"),Flag(r,"recover"),Text(r,"manifest_bytes"),Text(r,"replacement_bytes"),Flag(r,"delete"));
          Console.WriteLine(json.Serialize(new { ok=true, read_bytes=SourcePropertyCommit.BytesRead, mtime=SourcePropertyCommit.PublishedMtime }));
        }
      } catch {
        Console.WriteLine(args[0] == "attributes" ? "{\"error\":true}" : json.Serialize(new { ok=false, read_bytes=SourcePropertyCommit.BytesRead }));
      }
    }
  }
}
