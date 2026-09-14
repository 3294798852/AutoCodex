$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace AutoCodex {
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    void Advise(IFileOperationProgressSink sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOperationFlags(uint flags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
    void SetProgressDialog([MarshalAs(UnmanagedType.Interface)] object dialog);
    void SetProperties([MarshalAs(UnmanagedType.Interface)] object properties);
    void SetOwnerWindow(uint owner);
    void ApplyPropertiesToItem(IShellItem item);
    void ApplyPropertiesToItems([MarshalAs(UnmanagedType.Interface)] object items);
    void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
    void RenameItems([MarshalAs(UnmanagedType.Interface)] object items, [MarshalAs(UnmanagedType.LPWStr)] string name);
    void MoveItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
    void MoveItems([MarshalAs(UnmanagedType.Interface)] object items, IShellItem dest);
    void CopyItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
    void CopyItems([MarshalAs(UnmanagedType.Interface)] object items, IShellItem dest);
    void DeleteItem(IShellItem item, IFileOperationProgressSink sink);
    void DeleteItems([MarshalAs(UnmanagedType.Interface)] object items);
    void NewItem(IShellItem dest, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IFileOperationProgressSink sink);
    void PerformOperations();
    void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
  }
  [ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int result);
    [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
    [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
    [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
    [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
    [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem created);
    [PreserveSig] int PreNewItem(uint flags, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostNewItem(uint flags, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int result, IShellItem created);
    [PreserveSig] int UpdateProgress(uint total, uint done);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public class RecycleSink : IFileOperationProgressSink {
    public bool Recycled;
    public int Result;
    public int StartOperations(){return 0;} public int FinishOperations(int hr){return 0;}
    public int PreRenameItem(uint f,IShellItem i,string n){return 0;}
    public int PostRenameItem(uint f,IShellItem i,string n,int r,IShellItem c){return 0;}
    public int PreMoveItem(uint f,IShellItem i,IShellItem d,string n){return 0;}
    public int PostMoveItem(uint f,IShellItem i,IShellItem d,string n,int r,IShellItem c){return 0;}
    public int PreCopyItem(uint f,IShellItem i,IShellItem d,string n){return 0;}
    public int PostCopyItem(uint f,IShellItem i,IShellItem d,string n,int r,IShellItem c){return 0;}
    // TSF_DELETE_RECYCLE_IF_POSSIBLE must be present. Refuse permanent-delete callbacks.
    public int PreDeleteItem(uint f,IShellItem i){return (f & 0x80) != 0 ? 0 : unchecked((int)0x80004004);}
    public int PostDeleteItem(uint f,IShellItem i,int r,IShellItem c){Result=r; Recycled=r>=0 && c!=null; return 0;}
    public int PreNewItem(uint f,IShellItem d,string n){return 0;}
    public int PostNewItem(uint f,IShellItem d,string n,string t,uint a,int r,IShellItem c){return 0;}
    public int UpdateProgress(uint t,uint d){return 0;} public int ResetTimer(){return 0;}
    public int PauseTimer(){return 0;} public int ResumeTimer(){return 0;}
  }
  public static class Recycle {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    public static void One(string path) {
      IShellItem item=null; IFileOperation operation=null;
      try {
        Guid iid=typeof(IShellItem).GUID; SHCreateItemFromParsingName(path,IntPtr.Zero,ref iid,out item);
        operation=(IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
        // Silent, no confirmation/error UI, recycle-on-delete, stop on first error.
        operation.SetOperationFlags(0x00080000 | 0x00100000 | 0x00000400 | 0x00000010 | 0x00000004);
        var sink=new RecycleSink(); operation.DeleteItem(item,sink); operation.PerformOperations();
        bool aborted; operation.GetAnyOperationsAborted(out aborted);
        if(aborted || !sink.Recycled) throw new Exception("Recycle operation was not confirmed (HRESULT "+sink.Result+"). Do not retry automatically.");
      } finally { if(item!=null)Marshal.FinalReleaseComObject(item);if(operation!=null)Marshal.FinalReleaseComObject(operation); }
    }
  }
}
'@
$completed = @()
foreach ($recyclePath in $payload.paths) {
  try { [AutoCodex.Recycle]::One([string]$recyclePath); $completed += [string]$recyclePath }
  catch {
    @{ success = $false; recycled = $completed; failedPath = [string]$recyclePath; error = $_.Exception.Message; retryAllowed = $false } | ConvertTo-Json -Compress -Depth 5
    exit 0
  }
}
@{ success = $true; recycled = $completed; retryAllowed = $false } | ConvertTo-Json -Compress -Depth 5
