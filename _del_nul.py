import ctypes
import sys

# Raw NT-style path with \\?\ prefix to bypass Win32 device-name mapping (nul -> null device)
raw = r"\\?\D:\XIAZAI\浏览器\2026-10-09-03-06-27\tiktok-scraper\nul"

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
DeleteFileW = kernel32.DeleteFileW
DeleteFileW.argtypes = [ctypes.c_wchar_p]
DeleteFileW.restype = ctypes.c_int

ret = DeleteFileW(raw)
if ret:
    print("DELETED_OK")
else:
    err = ctypes.get_last_error()
    print("FAILED errno=%d" % err)
