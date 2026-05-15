/**
 * Device Service - Multi-brand smart device management
 * Supports: TP-Link Kasa, Govee, Tuya, Wyze, Tapo
 */

const { spawn } = require('child_process');
const path = require('path');
const goveeService = require('./govee-service');
const tuyaService = require('./tuya-service');
const kasaService = require('./kasa-service');
const wyzeService = require('./wyze-service');
const tapoService = require('./tapo-service');
const { safeJsonParse } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('DeviceService');
const PYTHON_DIR = path.join(__dirname, '..', 'python');

// Track active Python processes for cleanup (still needed for network_scan.py)
const activeProcesses = new Set();

/**
 * Kill all active Python processes (for emergency stop/shutdown)
 */
function killAllPythonProcesses() {
  for (const proc of activeProcesses) {
    try {
      // Check if process is still running before trying to kill it
      if (proc && proc.pid && !proc.killed && proc.exitCode === null) {
        // On Windows, use default signal (SIGTERM) which is handled as process termination
        proc.kill();
      }
    } catch (e) {
      // Ignore EPIPE errors (process already dead) and other harmless errors
      if (e.code !== 'EPIPE' && e.errno !== -4047) {
        log.error('Failed to kill process:', e.message);
      }
    }
  }
  activeProcesses.clear();
}

/**
 * Execute Python script and return JSON result
 * @param {string} script - Script filename
 * @param {string[]} args - Arguments to pass
 * @param {number} timeoutMs - Timeout in milliseconds (default 30s)
 */
function executePython(script, args = [], timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(PYTHON_DIR, script);
    const proc = spawn('python3', [scriptPath, ...args], {
      cwd: PYTHON_DIR
    });

    activeProcesses.add(proc);

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Set timeout for process
    const timeout = setTimeout(() => {
      killed = true;
      try {
        // Check if process is still running before trying to kill it
        if (proc && proc.pid && !proc.killed && proc.exitCode === null) {
          proc.kill(); // Use default signal for Windows compatibility
        }
      } catch (e) {
        // Ignore EPIPE errors (process already dead)
        if (e.code !== 'EPIPE' && e.errno !== -4047) {
          log.error('Failed to kill timed-out process:', e.message);
        }
      }
      activeProcesses.delete(proc);
      reject(new Error(`Python script ${script} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);

      if (killed) return; // Already rejected via timeout

      if (code !== 0 && !stdout) {
        reject(new Error(stderr || `Python script exited with code ${code}`));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(`Python script ${script} returned empty output`));
        return;
      }

      const result = safeJsonParse(trimmed);
      if (!result.success) {
        log.error('JSON parse error:', result.error);
        log.debug('Raw output preview:', trimmed.substring(0, 200));
        reject(new Error(`Invalid JSON from Python script: ${result.error}`));
        return;
      }

      resolve(result.data);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);
      reject(err);
    });
  });
}

class DeviceService {
  constructor() {
    this.devices = new Map(); // ip -> device info
    this.deviceStates = new Map(); // ip -> { state: 'on'|'off', lastUpdate }
    this.activeCycles = new Map(); // ip -> { timer, intervalTimer, settings }
    this.activePulses = new Map(); // ip -> { timers: [] } to cancel pulses
    this.pumpStartTimes = new Map(); // ip/deviceKey -> startTime for auto-capacity tracking
    this.pumpRuntimeIntervals = new Map(); // ip/deviceKey -> interval for real-time capacity updates
    this.eventEmitter = null;
  }

  /**
   * Set event emitter for device events
   */
  setEventEmitter(emitter) {
    this.eventEmitter = emitter;
  }

  /**
   * Emit device event
   */
  emitEvent(eventType, data) {
    if (this.eventEmitter) {
      this.eventEmitter(eventType, data);
    }
  }

  /**
   * Start real-time pump runtime tracking (emits updates every second)
   */
  startPumpRuntimeTracking(stateKey, device) {
    // Only track pumps with calibration data
    if (device?.deviceType !== 'PUMP' || !device?.calibrationTime) {
      return;
    }

    // Clear any existing interval
    this.stopPumpRuntimeTracking(stateKey);

    // Track start time AND store device info for later use
    this.pumpStartTimes.set(stateKey, {
      startTime: Date.now(),
      device: device,
      calibrationTime: device.calibrationTime
    });

    // Start interval for real-time updates (every 1 second)
    const interval = setInterval(() => {
      const trackingData = this.pumpStartTimes.get(stateKey);
      if (trackingData) {
        const runtimeSeconds = (Date.now() - trackingData.startTime) / 1000;
        this.emitEvent('pump_runtime', {
          ip: stateKey,
          device: trackingData.device,
          runtimeSeconds,
          calibrationTime: trackingData.calibrationTime,
          isRealTime: true
        });
      }
    }, 1000);

    this.pumpRuntimeIntervals.set(stateKey, interval);
    console.log(`[DeviceService] Started real-time capacity tracking for ${stateKey}, calibrationTime: ${device.calibrationTime}s`);
  }

  /**
   * Stop real-time pump runtime tracking and emit final update
   */
  stopPumpRuntimeTracking(stateKey, device = null) {
    // Clear interval
    const interval = this.pumpRuntimeIntervals.get(stateKey);
    if (interval) {
      clearInterval(interval);
      this.pumpRuntimeIntervals.delete(stateKey);
    }

    // Emit final runtime update - use stored device info if not provided
    const trackingData = this.pumpStartTimes.get(stateKey);
    if (trackingData) {
      const runtimeSeconds = (Date.now() - trackingData.startTime) / 1000;
      this.pumpStartTimes.delete(stateKey);

      // Use stored device/calibrationTime from when tracking started
      const deviceInfo = device || trackingData.device || this.devices.get(stateKey);
      const calibrationTime = trackingData.calibrationTime || deviceInfo?.calibrationTime;

      if (deviceInfo && calibrationTime) {
        this.emitEvent('pump_runtime', {
          ip: stateKey,
          device: deviceInfo,
          runtimeSeconds,
          calibrationTime: calibrationTime,
          isRealTime: false
        });
        console.log(`[DeviceService] Stopped tracking for ${stateKey}, final runtime: ${runtimeSeconds.toFixed(1)}s, calibrationTime: ${calibrationTime}s`);
      } else {
        console.warn(`[DeviceService] Could not emit final runtime for ${stateKey}: missing device or calibrationTime`);
      }
    }
  }

  /**
   * Stop ALL pump runtime tracking intervals (for emergency stop)
   * This ensures all intervals are cleared even if there are key mismatches
   */
  stopAllPumpRuntimeTracking() {
    console.log(`[DeviceService] Stopping ALL pump runtime tracking - ${this.pumpRuntimeIntervals.size} active intervals`);

    // Clear all intervals
    for (const [stateKey, interval] of this.pumpRuntimeIntervals.entries()) {
      clearInterval(interval);
      console.log(`[DeviceService] Cleared interval for ${stateKey}`);
    }

    // Clear the maps
    this.pumpRuntimeIntervals.clear();
    this.pumpStartTimes.clear();

    console.log('[DeviceService] All pump runtime tracking stopped');
  }

  /**
   * Scan network for Kasa devices (native Node.js implementation)
   */
  async scanNetwork(timeout = 10) {
    try {
      const ips = await kasaService.discover(timeout);
      // Get device info for each discovered IP
      const devices = await Promise.all(
        ips.map(async (ip) => {
          try {
            const device = new kasaService.KasaDevice(ip);
            const info = await device.getInfo();
            if (info.system?.get_sysinfo) {
              const sysinfo = info.system.get_sysinfo;
              return {
                ip,
                alias: sysinfo.alias || ip,
                model: sysinfo.model || 'Unknown',
                type: sysinfo.type || sysinfo.mic_type || 'Unknown',
                is_strip: !!sysinfo.children,
                child_num: sysinfo.child_num || 0
              };
            }
            return { ip, alias: ip, model: 'Unknown' };
          } catch (e) {
            return { ip, alias: ip, model: 'Unknown', error: e.message };
          }
        })
      );
      return devices;
    } catch (error) {
      log.error('Scan error:', error.message);
      return [];
    }
  }

  /**
   * Get device info (native Node.js implementation)
   */
  async getDeviceInfo(ip) {
    try {
      const device = new kasaService.KasaDevice(ip);
      return await device.getInfo();
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Get child outlets for multi-outlet devices (power strips like HS300)
   * @param {string} ip - Device IP address
   * @returns {Object} { is_strip, children: [{id, index, alias, state, relay_state}] }
   */
  async getChildren(ip) {
    try {
      const device = new kasaService.KasaDevice(ip);
      return await device.getChildren();
    } catch (error) {
      return { error: error.message, is_strip: false, children: [] };
    }
  }

  /**
   * Get unique key for device state tracking
   * For single outlets: ip
   * For power strip outlets: ip:childId
   */
  _getDeviceKey(ipOrDeviceId, device = null) {
    if (device?.childId) {
      return `${device.ip}:${device.childId}`;
    }
    return ipOrDeviceId;
  }

  /**
   * Get device state (routes by brand)
   * @param {string} ipOrDeviceId - IP address for TPLink, deviceId for Govee
   * @param {Object} device - Optional device object with brand info (may include childId for power strips)
   */
  async getDeviceState(ipOrDeviceId, device = null) {
    // Try to get device from registered devices if not provided
    if (!device) {
      device = this.devices.get(ipOrDeviceId);
    }

    const stateKey = this._getDeviceKey(ipOrDeviceId, device);

    try {
      // Route by brand
      if (device?.brand === 'govee') {
        const state = await goveeService.getPowerState(device.deviceId, device.sku);
        const result = {
          state,
          relay_state: state === 'on' ? 1 : 0
        };
        this.deviceStates.set(device.deviceId, {
          state: result.state,
          relayState: result.relay_state,
          lastUpdate: Date.now()
        });
        return result;
      }

      if (device?.brand === 'tuya') {
        const state = await tuyaService.getPowerState(device.deviceId);
        const result = {
          state,
          relay_state: state === 'on' ? 1 : 0
        };
        this.deviceStates.set(device.deviceId, {
          state: result.state,
          relayState: result.relay_state,
          lastUpdate: Date.now()
        });
        return result;
      }

      if (device?.brand === 'wyze') {
        const state = await wyzeService.getPowerState(device.deviceId);
        const result = {
          state,
          relay_state: state === 'on' ? 1 : 0
        };
        this.deviceStates.set(device.deviceId, {
          state: result.state,
          relayState: result.relay_state,
          lastUpdate: Date.now()
        });
        return result;
      }

      if (device?.brand === 'tapo') {
        const state = await tapoService.getPowerState(device.ip);
        const result = {
          state,
          relay_state: state === 'on' ? 1 : 0
        };
        this.deviceStates.set(device.ip, {
          state: result.state,
          relayState: result.relay_state,
          lastUpdate: Date.now()
        });
        return result;
      }

      // Default: TPLink Kasa (native Node.js implementation)
      const kasaDevice = new kasaService.KasaDevice(device?.ip || ipOrDeviceId, {
        childId: device?.childId
      });
      const result = await kasaDevice.getState();
      if (!result.error) {
        this.deviceStates.set(stateKey, {
          state: result.state,
          relayState: result.relay_state,
          lastUpdate: Date.now()
        });
      }
      return result;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Turn device on (routes by brand)
   * @param {string} ipOrDeviceId - IP address for TPLink, deviceId for Govee/Tuya
   * @param {Object} device - Optional device object with brand info (may include childId for power strips)
   * @param {Object} durationInfo - Optional duration info { untilType, untilValue }
   */
  async turnOn(ipOrDeviceId, device = null, durationInfo = null) {
    // Try to get device from registered devices if not provided
    if (!device) {
      device = this.devices.get(ipOrDeviceId);
    }

    const stateKey = this._getDeviceKey(ipOrDeviceId, device);

    // Debug logging
    console.log(`[DeviceService] turnOn called: ipOrDeviceId=${ipOrDeviceId}, brand=${device?.brand}, ip=${device?.ip}, childId=${device?.childId}`);

    try {
      // Route by brand
      if (device?.brand === 'govee') {
        await goveeService.turnOn(device.deviceId, device.sku);
        this.deviceStates.set(device.deviceId, {
          state: 'on',
          relayState: 1,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_on', { ip: device.deviceId, device, durationInfo });
        this.startPumpRuntimeTracking(device.deviceId, device);
        return { success: true, state: 'on' };
      }

      if (device?.brand === 'tuya') {
        if (!device.deviceId) {
          console.error(`[DeviceService] Tuya turnOn called but device.deviceId is missing! Device:`, JSON.stringify(device));
          return { error: 'Tuya device missing deviceId' };
        }
        await tuyaService.turnOn(device.deviceId);
        this.deviceStates.set(device.deviceId, {
          state: 'on',
          relayState: 1,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_on', { ip: device.deviceId, device, durationInfo });
        this.startPumpRuntimeTracking(device.deviceId, device);
        return { success: true, state: 'on' };
      }

      if (device?.brand === 'wyze') {
        await wyzeService.turnOn(device.deviceId, device.model);
        this.deviceStates.set(device.deviceId, {
          state: 'on',
          relayState: 1,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_on', { ip: device.deviceId, device, durationInfo });
        this.startPumpRuntimeTracking(device.deviceId, device);
        return { success: true, state: 'on' };
      }

      if (device?.brand === 'tapo') {
        await tapoService.turnOn(device.ip);
        this.deviceStates.set(device.ip, {
          state: 'on',
          relayState: 1,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_on', { ip: device.ip, device, durationInfo });
        this.startPumpRuntimeTracking(device.ip, device);
        return { success: true, state: 'on' };
      }

      // Default: TPLink Kasa (native Node.js implementation)
      console.log(`[DeviceService] Routing to NATIVE KASA: ip=${device?.ip || ipOrDeviceId}, childId=${device?.childId}`);
      const kasaDevice = new kasaService.KasaDevice(device?.ip || ipOrDeviceId, {
        childId: device?.childId
      });
      const result = await kasaDevice.turnOn();
      if (!result.error) {
        this.deviceStates.set(stateKey, {
          state: 'on',
          relayState: 1,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_on', { ip: stateKey, device: device || this.devices.get(ipOrDeviceId), durationInfo });
        this.startPumpRuntimeTracking(stateKey, device || this.devices.get(ipOrDeviceId));
      }
      return { success: !result.error, state: 'on', result };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Turn device off (routes by brand)
   * @param {string} ipOrDeviceId - IP address for TPLink, deviceId for Govee/Tuya
   * @param {Object} device - Optional device object with brand info (may include childId for power strips)
   * @param {Object} options - Optional { skipCycleStop: boolean } - if true, don't stop active cycles (used when called from within cycle logic)
   */
  async turnOff(ipOrDeviceId, device = null, options = {}) {
    // Try to get device from registered devices if not provided
    if (!device) {
      device = this.devices.get(ipOrDeviceId);
    }

    const stateKey = this._getDeviceKey(ipOrDeviceId, device);

    // Debug logging
    console.log(`[DeviceService] turnOff called: ipOrDeviceId=${ipOrDeviceId}, brand=${device?.brand}, ip=${device?.ip}, childId=${device?.childId}, skipCycleStop=${options.skipCycleStop}`);

    // Cancel any active pulses or cycles for this device (unless skip flags are set)
    if (!options.skipPulseStop) {
      this.stopPulse(ipOrDeviceId);
    }
    if (!options.skipCycleStop) {
      this.stopCycle(ipOrDeviceId, device);
    }

    try {
      // Route by brand
      if (device?.brand === 'govee') {
        await goveeService.turnOff(device.deviceId, device.sku);
        this.deviceStates.set(device.deviceId, {
          state: 'off',
          relayState: 0,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_off', { ip: device.deviceId, device });
        this.stopPumpRuntimeTracking(device.deviceId, device);
        return { success: true, state: 'off' };
      }

      if (device?.brand === 'tuya') {
        if (!device.deviceId) {
          console.error(`[DeviceService] Tuya turnOff called but device.deviceId is missing! Device:`, JSON.stringify(device));
          return { error: 'Tuya device missing deviceId' };
        }
        await tuyaService.turnOff(device.deviceId);
        this.deviceStates.set(device.deviceId, {
          state: 'off',
          relayState: 0,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_off', { ip: device.deviceId, device });
        this.stopPumpRuntimeTracking(device.deviceId, device);
        return { success: true, state: 'off' };
      }

      if (device?.brand === 'wyze') {
        await wyzeService.turnOff(device.deviceId, device.model);
        this.deviceStates.set(device.deviceId, {
          state: 'off',
          relayState: 0,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_off', { ip: device.deviceId, device });
        this.stopPumpRuntimeTracking(device.deviceId, device);
        return { success: true, state: 'off' };
      }

      if (device?.brand === 'tapo') {
        await tapoService.turnOff(device.ip);
        this.deviceStates.set(device.ip, {
          state: 'off',
          relayState: 0,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_off', { ip: device.ip, device });
        this.stopPumpRuntimeTracking(device.ip, device);
        return { success: true, state: 'off' };
      }

      // Default: TPLink Kasa (native Node.js implementation)
      console.log(`[DeviceService] Routing to NATIVE KASA: ip=${device?.ip || ipOrDeviceId}, childId=${device?.childId}`);
      const kasaDevice = new kasaService.KasaDevice(device?.ip || ipOrDeviceId, {
        childId: device?.childId
      });
      const result = await kasaDevice.turnOff();
      if (!result.error) {
        this.deviceStates.set(stateKey, {
          state: 'off',
          relayState: 0,
          lastUpdate: Date.now()
        });
        this.emitEvent('device_off', { ip: stateKey, device: device || this.devices.get(ipOrDeviceId) });
        this.stopPumpRuntimeTracking(stateKey, device || this.devices.get(ipOrDeviceId));
      }
      return { success: !result.error, state: 'off', result };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Toggle device state (native Node.js implementation)
   */
  async toggle(ip, device = null) {
    try {
      const kasaDevice = new kasaService.KasaDevice(device?.ip || ip, {
        childId: device?.childId
      });
      const current = await kasaDevice.getState();
      if (current.error) {
        return current;
      }
      if (current.relay_state === 1) {
        await kasaDevice.turnOff();
        return { success: true, state: 'off' };
      } else {
        await kasaDevice.turnOn();
        return { success: true, state: 'on' };
      }
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Start device cycling
   * @param {string} ip - Device IP
   * @param {Object} options
   * @param {number} options.duration - Seconds device stays on per cycle
   * @param {number} options.interval - Seconds between cycles
   * @param {number} options.cycles - Number of cycles (0 = infinite)
   * @param {boolean} options.repeat - Whether to repeat
   * @param {Object} device - Optional device object with brand info (may include childId for power strips)
   */
  async startCycle(ip, options = {}, device = null) {
    const { duration = 5, interval = 10, cycles = 0, repeat = false } = options;

    console.log(`[DeviceService] startCycle called: ip=${ip}, duration=${duration}s, interval=${interval}s, cycles=${cycles}, brand=${device?.brand}`);

    // Stop existing cycle if any
    this.stopCycle(ip, device);

    let currentCycle = 0;
    const maxCycles = cycles > 0 ? cycles : Infinity;

    const runCycle = async () => {
      if (currentCycle >= maxCycles) {
        // stopCycle will emit cycle_complete
        this.stopCycle(ip, device);
        return;
      }

      currentCycle++;
      console.log(`[DeviceService] Cycle ${currentCycle}: turning ON device ${ip} (brand: ${device?.brand})`);

      // Turn on (pass device object for proper brand/childId support)
      const onResult = await this.turnOn(ip, device);
      if (onResult.error) {
        console.error(`[DeviceService] Cycle ${currentCycle}: turnOn failed:`, onResult.error);
      }
      this.emitEvent('cycle_on', { ip, cycle: currentCycle, totalCycles: cycles, duration, device });

      // Schedule turn off
      const offTimer = setTimeout(async () => {
        try {
          console.log(`[DeviceService] Cycle ${currentCycle}: turning OFF device ${ip} after ${duration}s (brand: ${device?.brand})`);
          const offResult = await this.turnOff(ip, device, { skipCycleStop: true });
          if (offResult.error) {
            console.error(`[DeviceService] Cycle ${currentCycle}: turnOff failed:`, offResult.error);
          }
          this.emitEvent('cycle_off', { ip, cycle: currentCycle, device });

          // Schedule next cycle if not done
          if (currentCycle < maxCycles || repeat) {
            console.log(`[DeviceService] Scheduling next cycle in ${interval}s`);
            const nextTimer = setTimeout(runCycle, interval * 1000);
            const cycleInfo = this.activeCycles.get(ip);
            if (cycleInfo) {
              cycleInfo.intervalTimer = nextTimer;
            }
          } else {
            // stopCycle will emit cycle_complete
            console.log(`[DeviceService] Cycle complete after ${currentCycle} cycles`);
            this.stopCycle(ip, device);
          }
        } catch (err) {
          console.error(`[DeviceService] Cycle ${currentCycle}: error in turnOff callback:`, err.message);
        }
      }, duration * 1000);

      this.activeCycles.set(ip, {
        timer: offTimer,
        intervalTimer: null,
        settings: options,
        device, // Store device object for stopCycle
        currentCycle,
        startTime: Date.now()
      });
    };

    // Start first cycle
    await runCycle();

    return { success: true, message: 'Cycle started' };
  }

  /**
   * Stop device cycling
   * @param {string} ip - Device IP or ID
   * @param {Object} device - Optional device object with brand info (may include childId for power strips)
   */
  async stopCycle(ip, device = null) {
    const cycleInfo = this.activeCycles.get(ip);
    if (cycleInfo) {
      if (cycleInfo.timer) clearTimeout(cycleInfo.timer);
      if (cycleInfo.intervalTimer) clearTimeout(cycleInfo.intervalTimer);
      const cycleCount = cycleInfo.currentCycle || 0;
      // Use stored device object if not provided
      const deviceObj = device || cycleInfo.device;
      this.activeCycles.delete(ip);

      // Turn off the device first (pass device object for proper brand/childId support)
      // Use skipCycleStop since we're already stopping the cycle here
      await this.turnOff(ip, deviceObj, { skipCycleStop: true });

      // Emit cycle_complete when manually stopped
      this.emitEvent('cycle_complete', { ip, cycles: cycleCount, manual: true, device: deviceObj });

      return { success: true, message: 'Cycle stopped' };
    }
    return { success: false, message: 'No active cycle' };
  }

  /**
   * Pulse device (quick on/off bursts)
   * @param {string} ip - Device IP or ID
   * @param {number} pulses - Number of pulses (default 3)
   * @param {Object} device - Optional device object with brand info
   */
  async pulsePump(ip, pulses = 3, device = null) {
    console.log(`[DeviceService] pulsePump called: ip=${ip}, pulses=${pulses}, brand=${device?.brand}`);

    // Cancel any existing pulse for this device
    this.stopPulse(ip);

    let currentPulse = 0;
    const pulseDuration = 500; // 0.5 seconds on
    const pulseInterval = 1000; // 1 second total (0.5s on, 0.5s off)
    const timers = [];

    // Store pulse info for cancellation
    this.activePulses.set(ip, { timers, device });

    const runPulse = async () => {
      // Check if pulse was cancelled
      if (!this.activePulses.has(ip)) {
        console.log(`[DeviceService] Pulse cancelled for ${ip}`);
        return;
      }

      if (currentPulse >= pulses) {
        console.log(`[DeviceService] Pulse complete after ${currentPulse} pulses`);
        this.activePulses.delete(ip);
        return;
      }

      currentPulse++;
      console.log(`[DeviceService] Pulse ${currentPulse}: turning ON device ${ip}`);

      try {
        await this.turnOn(ip, device);
        this.emitEvent('pulse_on', { ip, pulse: currentPulse, totalPulses: pulses, device });

        // Turn off after pulse duration
        const offTimer = setTimeout(async () => {
          try {
            console.log(`[DeviceService] Pulse ${currentPulse}: turning OFF device ${ip}`);
            await this.turnOff(ip, device, { skipPulseStop: true });
            this.emitEvent('pulse_off', { ip, pulse: currentPulse, totalPulses: pulses, device });

            // Schedule next pulse
            if (currentPulse < pulses && this.activePulses.has(ip)) {
              const nextTimer = setTimeout(runPulse, pulseInterval - pulseDuration);
              timers.push(nextTimer);
            } else if (currentPulse >= pulses) {
              // All pulses complete
              this.emitEvent('pulse_complete', { ip, totalPulses: pulses, device });
              this.activePulses.delete(ip);
            }
          } catch (err) {
            console.error(`[DeviceService] Pulse ${currentPulse}: error in turnOff:`, err.message);
          }
        }, pulseDuration);
        timers.push(offTimer);
      } catch (err) {
        console.error(`[DeviceService] Pulse ${currentPulse}: error in turnOn:`, err.message);
      }
    };

    await runPulse();
    return { success: true, message: `Pulsing ${pulses} times` };
  }

  /**
   * Stop active pulse for device
   */
  stopPulse(ip) {
    const pulseInfo = this.activePulses.get(ip);
    if (pulseInfo) {
      console.log(`[DeviceService] Stopping pulse for ${ip}`);
      // Cancel all timers
      if (pulseInfo.timers) {
        pulseInfo.timers.forEach(timer => clearTimeout(timer));
      }
      this.activePulses.delete(ip);
      this.emitEvent('pulse_cancelled', { ip, device: pulseInfo.device });
    }
  }

  /**
   * Check if device is cycling
   */
  isCycling(ip) {
    return this.activeCycles.has(ip);
  }

  /**
   * Get cycle status
   */
  getCycleStatus(ip) {
    const cycleInfo = this.activeCycles.get(ip);
    if (cycleInfo) {
      return {
        cycling: true,
        currentCycle: cycleInfo.currentCycle,
        settings: cycleInfo.settings,
        elapsedTime: Date.now() - cycleInfo.startTime
      };
    }
    return { cycling: false };
  }

  /**
   * Register a device (supports all brands)
   */
  registerDevice(device) {
    // Use deviceId for cloud-based devices (Govee, Tuya, Wyze, Matter)
    // Use ip for local devices (TPLink Kasa, Tapo)
    const cloudBrands = ['govee', 'tuya', 'wyze'];
    const key = cloudBrands.includes(device.brand) ? device.deviceId : device.ip;
    this.devices.set(key, device);
  }

  /**
   * Unregister a device
   * @param {string} ipOrDeviceId - IP for TPLink, deviceId for Govee
   */
  unregisterDevice(ipOrDeviceId) {
    this.stopCycle(ipOrDeviceId);
    this.devices.delete(ipOrDeviceId);
    this.deviceStates.delete(ipOrDeviceId);
  }

  /**
   * Get all registered devices
   */
  getDevices() {
    return Array.from(this.devices.values());
  }

  /**
   * Get all device states
   */
  getAllStates() {
    const states = {};
    for (const [ip, state] of this.deviceStates) {
      states[ip] = state;
    }
    return states;
  }
}

module.exports = { DeviceService, killAllPythonProcesses, activeProcesses };
