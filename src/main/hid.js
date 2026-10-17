/**
 * HID 通信层 —— node-hid 封装，适配 WebHID → node-hid 的语义差异。
 *
 * 差异对照（见 docs/protocol.md §2）：
 *   WebHID sendFeatureReport(9, data)      → node-hid sendFeatureReport([9, ...data])
 *   WebHID receiveFeatureReport(9)         → node-hid getFeatureReport(9, LEN)
 *   WebHID sendReport(9, data)             → node-hid write([9, ...data])
 *
 * 枚举优化：HID.devices() 在 Windows 上耗时约 15 秒且同步阻塞。
 * 为避免主进程事件循环被阻塞（导致「未响应」），枚举在 worker 线程中执行，
 * 主进程在启动时预枚举并缓存结果。
 */

'use strict';

const { Worker } = require('worker_threads');
const HID = require('node-hid');
const P = require('../shared/protocol');

// ── 设备缓存与枚举 ──────────────────────────────────────────
let deviceCache = null; // 枚举结果缓存
let enumeratePromise = null; // 进行中的枚举 Promise

/**
 * 判断是否无线（已知无线 PID 0x522C，或 product 名含 wireless）。
 */
function isWirelessDevice(d) {
  if (d.productId === P.PID_WIRELESS) return true;
  const name = (d.product || '').toLowerCase();
  return name.includes('wireless') || name.includes('无线');
}

/**
 * 过滤出 Incott 鼠标的配置接口。
 * 兼容多型号：按 VID 0x093A（PixArt）+ usagePage 0xFF05 + usage 0x0001 匹配，
 * 不限制具体 PID（因科特各型号共用 PixArt VID，配置通道 usage 一致）。
 */
function filterDevices(devices) {
  return devices
    .filter(
      (d) =>
        d.vendorId === P.VID &&
        d.usagePage === P.USAGE_PAGE &&
        d.usage === P.USAGE
    )
    .map((d) => ({
      vendorId: d.vendorId,
      productId: d.productId,
      path: d.path,
      serialNumber: d.serialNumber,
      manufacturer: d.manufacturer,
      product: d.product,
      isWireless: isWirelessDevice(d),
    }));
}

/**
 * 异步枚举设备（在 worker 线程中执行，不阻塞主进程）。
 * 首次调用启动 worker，结果缓存；后续调用直接返回缓存。
 */
function listDevicesAsync() {
  if (deviceCache) return Promise.resolve(deviceCache);
  if (enumeratePromise) return enumeratePromise;

  enumeratePromise = new Promise((resolve, reject) => {
    const workerSrc = `
      const { parentPort } = require('worker_threads');
      try {
        const HID = require('node-hid');
        const all = HID.devices();
        const filtered = all.filter(d =>
          d.vendorId === ${P.VID} &&
          d.usagePage === ${P.USAGE_PAGE} &&
          d.usage === ${P.USAGE}
        );
        parentPort.postMessage({ ok: true, devices: filtered });
      } catch (e) {
        parentPort.postMessage({ ok: false, error: e.message });
      }
    `;
    const worker = new Worker(workerSrc, { eval: true });
    worker.on('message', (msg) => {
      if (msg.ok) {
        deviceCache = filterDevices(msg.devices);
        resolve(deviceCache);
      } else {
        reject(new Error(msg.error));
      }
    });
    worker.on('error', (e) => reject(e));
    worker.on('exit', (code) => {
      if (code !== 0 && !deviceCache) {
        reject(new Error(`枚举 worker 退出码 ${code}`));
      }
    });
  });
  return enumeratePromise;
}

/** 触发后台预枚举（应用启动时调用，结果缓存，连接时秒开） */
function prewarm() {
  listDevicesAsync().catch(() => {
    /* 预枚举失败不阻塞，连接时重试 */
  });
}

/**
 * 同步枚举（保留兼容；会阻塞，优先用 listDevicesAsync）。
 */
function listDevices() {
  if (deviceCache) return deviceCache;
  try {
    return filterDevices(HID.devices());
  } catch (e) {
    return [];
  }
}

class MouseDevice {
  constructor(path) {
    this._dev = new HID.HID(path);
    this.path = path;
    let info = null;
    try {
      info = this._dev.getDeviceInfo();
    } catch (_) {
      info = null;
    }
    this.productId = info ? info.productId : null;
    this.product = info ? info.product : '';
    this.isWireless = this.productId === P.PID_WIRELESS ||
      /wireless|无线/i.test(this.product || '');
  }

  /** 发送 Feature Report（8 字节数据 + reportId=9） */
  sendFeatureReport(data) {
    const buf = Buffer.concat([Buffer.from([P.REPORT_ID]), data]);
    this._dev.sendFeatureReport(buf);
  }

  /**
   * 读取 Feature Report。
   * node-hid 返回的 Buffer 含 reportId（byte 0），此处剥离后返回 8 字节数据区。
   */
  getFeatureReport(length = P.REPORT_DATA_LEN) {
    const buf = this._dev.getFeatureReport(P.REPORT_ID, length + 1);
    return buf.slice(1);
  }

  /** 发送 Output Report（宏分块上传等） */
  sendReport(data) {
    const buf = Buffer.concat([Buffer.from([P.REPORT_ID]), data]);
    this._dev.write(buf);
  }

  close() {
    try {
      this._dev.close();
    } catch (_) {
      /* 已关闭 */
    }
  }
}

/**
 * 打开设备（按 path，或自动选可通信的接口）。
 *
 * 多接口场景：插线充电时 0xFF05 会出现 Col01/Col02 两个接口，
 * Col01 发送 Feature Report 会失败（返回错误数据），必须用 Col02。
 * 这里逐个尝试（Col02 优先，即枚举靠后的接口），选第一个能通信的。
 */
function openDevice(path) {
  if (path) {
    return new MouseDevice(path);
  }
  const list = listDevices();
  if (list.length === 0) {
    throw new Error('未找到 Incott 鼠标（VID 0x093A）');
  }
  let lastErr = null;
  for (const d of [...list].reverse()) {
    try {
      const dev = new MouseDevice(d.path);
      // 探测通信：Col01 在此抛错（HidD_SetFeature 失败）
      dev.sendFeatureReport(P.buildReadBattery());
      return dev;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有接口均无法通信');
}

module.exports = {
  listDevices,
  listDevicesAsync,
  prewarm,
  openDevice,
  MouseDevice,
};
