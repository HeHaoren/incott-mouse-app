# Incott Mouse Driver

因科特（Incott）鼠标的独立桌面配置工具。基于逆向的 HID 协议实现，**不依赖官方网页驱动**（`incott.net/mouse`）和官方桌面软件。

## 功能

- **DPI 设置**：多档位、滑块 + 精确输入（回车生效）、XY 轴单独调节、档位增删切换
- **键位设置**：系统按键 / 键盘按键 / 多媒体 / 录制宏 四类映射
- **性能设置**：回报率（125~8000Hz）、LOD 高度调节、运动同步 / 直线修正 / 波纹修正、按键响应时间
- **宏**：10 个槽位，按下/释放 + 延迟动作编辑，分块上传到鼠标
- **板载配置**：5 个 profile 切换
- **中英文切换**（含菜单栏）

## 支持设备

- VID `0x093A`（PixArt 原相），usagePage `0xFF05` 的因科特鼠标配置接口
- 已实测：incott 8K wireless mouse（PID `0x522C`，PAW3950 传感器）
- 其他因科特型号（G23/G24/GHERO 等）共用同一协议框架，理论上兼容，未逐一实测

## 技术栈

- Electron 33 + node-hid（N-API，ABI 稳定）
- 原生 HTML/CSS/JS 渲染进程（无前端框架）
- 协议层为纯函数，含单元测试（`node --test`）

## 运行

```bash
npm install
npm start
```

## 测试

```bash
npm test
```

## 打包

```bash
npm run dist
```

产物在 `dist/`：
- `Incott Mouse Driver Setup 0.1.0.exe`（NSIS 安装包）
- `win-unpacked/Incott Mouse Driver.exe`（免安装版）

## 目录结构

```
src/
  main/       Electron 主进程（窗口、HID 通信、IPC）
  preload/    contextBridge 桥接
  renderer/   渲染进程 UI
  shared/     协议层（protocol.js）+ 文案字典（i18n.js）
docs/protocol.md   逆向协议文档
test/              单元测试
```

## 免责声明

本项目通过逆向工程分析官方网页驱动的通信协议实现，仅供个人学习与设备配置用途。不包含任何官方软件的代码或资源，与因科特（Incott）官方无关。
