# Incott Mouse Driver

因科特（Incott）鼠标的独立桌面配置工具。基于逆向的 HID 协议实现，**不依赖官方网页驱动**（`incott.net/mouse`）和官方桌面软件。

## 功能

- **DPI 设置**：多档位、滑块 + 精确输入（回车生效）、XY 轴单独调节、档位增删切换
- **键位设置**：系统按键 / 键盘按键 / 多媒体 / 录制宏 四类映射
- **性能设置**：回报率（125~8000Hz）、LOD 高度调节、运动同步 / 直线修正 / 波纹修正、按键响应时间、节能调节（10~900s）
- **宏**：10 个槽位，按下/释放 + 延迟动作编辑，分块上传到鼠标
- **5 个配置**：与官方桌面驱动一致的 5 份预设；切换时把整套配置写入鼠标（实测硬件只有 1 份板载配置，序号只是标记）
- **软件更新**：顶栏「检查更新」按钮（有新版本时亮紫点），发现新版本后可在应用内下载安装包并启动安装器覆盖升级
- **中英文切换**（含菜单栏）

## 支持设备

- VID `0x093A`（PixArt 原相），usagePage `0xFF05` 的因科特鼠标配置接口
- 已实测：incott 8K wireless mouse（PID `0x522C`，PAW3950 传感器）
- 其他因科特型号（G23/G24/GHERO 等）共用同一协议框架，理论上兼容，未逐一实测

## 关于指示灯颜色（常见误解）

**DPI 档位的颜色固定为官方默认六色（红/蓝/绿/黄/青/品红），界面里不提供修改入口，鼠标上的灯色也改不了。**
色块只用来区分档位，并随 `.ict` 一起存档。

G24 的灯由固件按状态决定：

- **8K 接收器灯 = 回报率**：红 125 / 蓝 250 / 黄 500 / 橙 1000 / **紫 2000** / 绿 4000 / 白 8000；电量低于 33% 时改为显示电量
- **本体那颗 key indicator light**：配对闪烁、充电红灯、低电量闪红，不可设置

DPI 命令里虽然带了 RGB 三个字节（`buf[4..6]`，可写可回读、断电不丢），但 G24 固件不拿它驱动 LED——A/B 实测写纯绿/纯红后切档灯色完全不变，官方网页驱动也把这三位恒填 0。

想换灯色只能改回报率。完整说明见 [`docs/led-behavior.md`](docs/led-behavior.md)。

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

## 软件更新

顶栏的「检查更新」按钮（设置面板里也有同一入口）会读取 GitHub Releases 的最新正式版本：

- 走 `releases.atom` 与 `expanded_assets` 页面，不调用 GitHub API，避免匿名请求的 60 次/小时限流；
- 只认 `vX.Y.Z` 正式版，自动跳过 `preview` 等预发布标签；
- 发现新版本后，应用内下载 `Incott-Mouse-Driver-Setup-<版本>.exe` 到临时目录（显示进度），完成后启动安装器覆盖升级；
- 启动 8 秒后会自动静默检查一次，有新版本时弹提示并点亮顶栏按钮。

> 下载速度取决于本机到 GitHub 的连通性；安装包未做签名校验（本项目构建本身未签名），也没有断点续传。
> 旧版本要收到更新，前提是发布一个新版本（升 `package.json` 版本号并上传 Setup 包）。

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
