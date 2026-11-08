// WGC interop: GraphicsCaptureItem creation for HWNDs, D3D11 device
// bridging, and CPU readback of captured frames.
//
// Patterns follow the Microsoft Win32CaptureSample: the IGraphicsCaptureItemInterop
// COM interface creates items for windows, CreateDirect3D11DeviceFromDXGIDevice
// bridges a D3D11 device into the WinRT IDirect3DDevice, and the captured
// texture is copied to a staging resource for pixel readback.

using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Trylo.WgcHelper;
using Vortice.Direct3D11;
using WinRT;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX.Direct3D11;

namespace Trylo.WgcHelper;

[ComImport]
[Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow(nint window, ref Guid iid);
    IntPtr CreateForMonitor(nint monitor, ref Guid iid);
}

[ComImport]
[Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDirect3DDxgiInterfaceAccess
{
    IntPtr GetInterface([In] ref Guid iid);
}

internal static class CaptureInterop
{
    // GraphicsCaptureItem's default interface IID — the projected class's
    // Type.GUID is NOT this; hardcode it like the Win32CaptureSample does.
    internal static readonly Guid GraphicsCaptureItemIid =
        new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    public static GraphicsCaptureItem CreateItemForWindow(nint hwnd)
    {
        var factory = WinRT.ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");
        var interop = factory.AsInterface<IGraphicsCaptureItemInterop>();
        var iid = GraphicsCaptureItemIid;
        var pointer = interop.CreateForWindow(hwnd, ref iid);
        try
        {
            return GraphicsCaptureItem.FromAbi(pointer);
        }
        finally
        {
            Marshal.Release(pointer);
        }
    }
}

internal static class Direct3D11Helper
{
    [DllImport("d3d11.dll", ExactSpelling = true, SetLastError = false)]
    [return: MarshalAs(UnmanagedType.Error)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("d3d11.dll", ExactSpelling = true, SetLastError = false)]
    [return: MarshalAs(UnmanagedType.Error)]
    private static extern int D3D11CreateDevice(
        IntPtr adapter,
        uint driverType,
        IntPtr software,
        uint flags,
        IntPtr featureLevels,
        uint numFeatureLevels,
        uint sdkVersion,
        out IntPtr device,
        IntPtr featureLevel,
        IntPtr immediateContext);

    public static IDirect3DDevice CreateDevice()
    {
        var hr = D3D11CreateDevice(
            IntPtr.Zero, driverType: 1, IntPtr.Zero, flags: 0x20,
            IntPtr.Zero, 0, 7, out var d3dDevice, IntPtr.Zero, IntPtr.Zero);
        Marshal.ThrowExceptionForHR(hr);

        hr = CreateDirect3D11DeviceFromDXGIDevice(d3dDevice, out var inspectable);
        Marshal.ThrowExceptionForHR(hr);

        try
        {
            var inspectableObject = WinRT.MarshalInspectable<object>.FromAbi(inspectable);
            return inspectableObject.As<IDirect3DDevice>();
        }
        finally
        {
            Marshal.Release(inspectable);
            Marshal.Release(d3dDevice);
        }
    }

    public static byte[] EncodePng(Windows.Graphics.DirectX.Direct3D11.IDirect3DSurface surface)
    {
        var access = surface.As<IDirect3DDxgiInterfaceAccess>();
        var texturePtr = IntPtr.Zero;
        try
        {
            var iid = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"); // ID3D11Texture2D
            texturePtr = access.GetInterface(ref iid);
            using var texture = new ID3D11Texture2D(texturePtr);
            texturePtr = IntPtr.Zero;

            var desc = texture.Description;
            var width = checked((int)desc.Width);
            var height = checked((int)desc.Height);

            var stagingDesc = new Texture2DDescription
            {
                Width = width,
                Height = height,
                MipLevels = 1,
                ArraySize = 1,
                Format = desc.Format,
                SampleDescription = new Vortice.DXGI.SampleDescription(1, 0),
                Usage = ResourceUsage.Staging,
                BindFlags = BindFlags.None,
                CPUAccessFlags = CpuAccessFlags.Read,
                MiscFlags = ResourceOptionFlags.None,
            };
            using var staging = texture.Device.CreateTexture2D(stagingDesc);
            using var context = texture.Device.ImmediateContext;
            context.CopyResource(staging, texture);
            var mapped = context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);

            try
            {
                unsafe
                {
                    using var bitmap = new Bitmap(width, height, (int)mapped.RowPitch,
                        PixelFormat.Format32bppArgb, (nint)mapped.DataPointer);
                    using var stream = new MemoryStream();
                    bitmap.Save(stream, ImageFormat.Png);
                    return stream.ToArray();
                }
            }
            finally
            {
                context.Unmap(staging, 0);
            }
        }
        finally
        {
            if (texturePtr != IntPtr.Zero)
            {
                Marshal.Release(texturePtr);
            }
        }
    }
}
