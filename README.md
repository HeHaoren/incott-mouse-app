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
npm run dist     # 应用本体：dist/win-unpacked + NSIS 版安装包（备用）
npm run setup    # 自绘安装器：dist/Incott-Mouse-Driver-Setup-<版本>.exe
```

`npm run setup` 会先把 `dist/win-unpacked` 同步成安装器载荷，再打便携版自解压 exe（约 126 MB）。

产物在 `dist/`：
- `Incott-Mouse-Driver-Setup-<版本>.exe` —— **正式安装包**，自绘界面（深色卡片、可选安装路径、自绘进度）
- `Incott-Mouse-Driver-NSIS-<版本>.exe` —— NSIS 版，外观普通，留作备用
- `win-unpacked/Incott Mouse Driver.exe` —— 免安装版

## 安装器

`installer/` 是一个独立的小 Electron 应用，不复用 NSIS 的向导外壳：

- 660×436 无边框透明窗口，圆角卡片、自绘最小化/关闭，视觉与主程序同一套
- 四个状态：选项（安装位置 + 快捷方式）→ 进度 → 完成 → 出错
- 安装动作：复制载荷、建快捷方式（PowerShell WScript.Shell）、写 `HKCU` 卸载注册表项
- 卸载：注册表里的 `UninstallString` 指向装好的主程序 `--uninstall`，
  由程序自己删除快捷方式、注册表项并调度目录删除

```bash
npm run assets   # 顺带生成 installer/assets/splash.bmp（便携版解包时的闪屏）
```

## 品牌资产

安装包图标与 NSIS 侧图/顶图由 `build/make-assets.js` 用 Electron 自身渲染生成（不依赖 ImageMagick）：

```bash
npm run assets      # → build/generated/{icon.ico,icon.png,installerSidebar.bmp,installerHeader.bmp}
```

改完 `build/assets-src.html` 里的视觉后重跑一次，再重新打包即可。

## 目录结构

```
src/
  main/       Electron 主进程（窗口、HID 通信、IPC）
  preload/    contextBridge 桥接
  renderer/   渲染进程 UI
  shared/     协议层（protocol.js）+ 文案字典（i18n.js）+ 键位显示名（keynames.js）
installer/    自绘安装器（独立 Electron app：main.js + ui/ + 载荷同步与收集脚本）
build/        品牌资产源文件与生成脚本
docs/protocol.md   逆向协议文档
test/              单元测试
```

## 免责声明

本项目通过逆向工程分析官方网页驱动的通信协议实现，仅供个人学习与设备配置用途。不包含任何官方软件的代码或资源，与因科特（Incott）官方无关。
