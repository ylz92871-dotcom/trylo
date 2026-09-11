using System;
using System.Threading;

namespace TryloDesktopPet;

/// <summary>
/// Single-instance ownership for the pet (audit §4.2 PET-P0-5).
/// </summary>
/// <remarks>
/// The mutex alone used to be the whole story: a second launch found the
/// mutex taken and simply exited. If the running instance was hidden
/// (ShowOnlyWhenMinimized), off-screen (a saved Left/Top on a monitor that
/// was unplugged), or waiting for a client that never reconnected, the user
/// clicked "enable the pet" and NOTHING happened — the exact "pet does not
/// appear" symptom, with no error anywhere.
///
/// The mutex is kept (it is still the authority on "am I the instance?"),
/// but a second launch now also signals a named EventWaitHandle that the
/// first instance is listening on. The first instance then shows, activates,
/// and clamps itself back onto a visible screen.
/// </remarks>
internal sealed class SingleInstance : IDisposable
{
    /// <summary>Mutex name — unchanged, so existing deployments keep working.</summary>
    public const string MutexName = @"Local\TryloCodeDesktopPet";

    /// <summary>Wake-up channel between a second launch and the running instance.</summary>
    public const string WakeEventName = @"Local\TryloCodeDesktopPetWake";

    private readonly Mutex _mutex;
    private readonly EventWaitHandle? _wakeEvent;
    private readonly bool _isFirstInstance;

    private SingleInstance(Mutex mutex, EventWaitHandle? wakeEvent, bool isFirstInstance)
    {
        _mutex = mutex;
        _wakeEvent = wakeEvent;
        _isFirstInstance = isFirstInstance;
    }

    public bool IsFirstInstance => _isFirstInstance;

    /// <summary>
    /// Acquire single-instance ownership. When another instance already owns
    /// it, that instance is asked to wake up before we return.
    /// </summary>
    public static SingleInstance Acquire()
    {
        var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (isFirstInstance)
        {
            // We own it: create the wake channel so later launches can reach us.
            EventWaitHandle wakeEvent;
            try
            {
                wakeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, WakeEventName);
            }
            catch
            {
                // Named objects can be refused (sandboxed / permission edge
                // cases). Single-instance still holds via the mutex; only the
                // wake-up is lost, which degrades to the old behaviour.
                wakeEvent = null!;
            }
            return new SingleInstance(mutex, wakeEvent == null ? null : wakeEvent, true);
        }

        AskExistingInstanceToWake();
        return new SingleInstance(mutex, null, false);
    }

    private static void AskExistingInstanceToWake()
    {
        try
        {
            // Open (never create) — if nobody is listening there is nothing
            // to wake and we must not become the channel owner.
            using var wake = EventWaitHandle.OpenExisting(WakeEventName);
            wake.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            // The running instance predates this channel; nothing to do.
        }
        catch
        {
            // Best effort: a failed wake must never block this launch.
        }
    }

    /// <summary>
    /// Run <paramref name="onWake"/> on a background thread every time another
    /// launch asks us to show ourselves. The callback is marshalled onto the
    /// UI thread by the caller (PetWindow dispatches it).
    /// </summary>
    public void ListenForWake(Action onWake)
    {
        if (_wakeEvent is null) return;
        var thread = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    if (!_wakeEvent.WaitOne()) return;
                }
                catch
                {
                    return; // handle closed during shutdown
                }
                try
                {
                    onWake();
                }
                catch
                {
                    // A failed wake must never take the listener down.
                }
            }
        })
        {
            IsBackground = true,
            Name = "TryloDesktopPet.WakeListener",
        };
        thread.Start();
    }

    public void Dispose()
    {
        try
        {
            _wakeEvent?.Dispose();
        }
        catch
        {
            // ignore
        }
        try
        {
            _mutex.Dispose();
        }
        catch
        {
            // ignore
        }
    }
}
