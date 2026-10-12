/**
 * HID 通信层 —— node-hid 封装，适配 WebHID → node-hid 的语义差异。
 *
 * 差异对照（见 docs/protocol.md §2）：
 *   WebHID sendFeatureReport(9, data)      → node-hid sendFeatureReport([9, ...data])
 *   WebHID receiveFeatureReport(9)         → node-hid getFeatureReport(9, LEN)
 *   WebHID sendReport(9, data)             → node-hid write([9, ...data])
 */

'use strict';

const HID = require('node-hid');
const P = require('../shared/protocol');

/**
 * 枚举匹配的 Incott 鼠标。
 * @returns {Array<{vendorId, productId, path, serialNumber, manufacturer, product, isWireless}>}
 */
function listDevices() {
  let devices = [];
  try {
    devices = HID.devices();
  } catch (e) {
    return [];
  }
  return devices
    // 关键：必须按 usagePage/usage 过滤到 feature report 通信接口
    // （VID/PID 会匹配到 8 个 HID 接口，只有 usagePage=0xFF05&usage=1 是配置通道）
    .filter(
      (d) =>
        d.vendorId === P.VID &&
        (d.productId === P.PID_WIRED || d.productId === P.PID_WIRELESS) &&
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
      isWireless: d.productId === P.PID_WIRELESS,
    }));
}

class MouseDevice {
  constructor(path) {
    this._dev = new HID.HID(path);
    this.path = path;
    this.productId = this._dev.getDeviceInfo
      ? (this._dev.getDeviceInfo().productId)
      : null;
    this.isWireless = this.productId === P.PID_WIRELESS;
  }

  /** 发送 Feature Report（8 字节数据 + reportId=9） */
  sendFeatureReport(data) {
    const buf = Buffer.concat([Buffer.from([P.REPORT_ID]), data]);
    this._dev.sendFeatureReport(buf);
  }

  /**
   * 读取 Feature Report。
   * node-hid 返回的 Buffer 含 reportId（byte 0），此处剥离后返回 8 字节数据区。
   * 实测：feature report 数据区 8 字节，总长 9（= reportId + 8 数据）。
   */
  getFeatureReport(length = P.REPORT_DATA_LEN) {
    // length + 1 是因为 node-hid 返回含 reportId
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
 * 打开设备（按 path 或自动选第一个匹配设备）。
 */
function openDevice(path) {
  if (path) {
    return new MouseDevice(path);
  }
  const list = listDevices();
  if (list.length === 0) {
    throw new Error('未找到 Incott 鼠标（VID 0x093A）');
  }
  return new MouseDevice(list[0].path);
}

module.exports = {
  listDevices,
  openDevice,
  MouseDevice,
};
