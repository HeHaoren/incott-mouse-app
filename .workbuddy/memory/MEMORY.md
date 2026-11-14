# Incott Mouse App — 项目长期记忆

## 项目概况
Incott（因科特）鼠标桌面配置工具，Electron + node-hid，不依赖官方网页驱动。
逆向依据：`F:\AI Agent\Reverse Engineer Anything\incott-web-driver-re`（分析报告 + Caldis 实机验证 + oexi 移植版源码）。

## 环境与构建
- Node 在 `F:\AI Agent\nodejs\node.exe`（系统 PATH 未必有，脚本里 `export PATH="/f/AI Agent/nodejs:$PATH"`）
- 测试：`node --test`（当前 41 个全绿）；语法检查 `node --check`
- 打包：`npm run dist`（electron-builder + NSIS）。**打包前必须 taskkill "Incott Mouse Driver.exe"**，否则 dist 文件被占用报 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
- 用户设置持久化在 `%APPDATA%\incott-mouse-app\settings.json`

## Git / 推送（本机网络特殊）
- 远程 `origin https://github.com/HeHaoren/incott-mouse-app.git`，分支 master；gh CLI 已登录 HeHaoren
- **本机 DNS 把 github.com 解析到 20.205.243.166（被墙，TCP 不通）**，而 140.82.112.3/113.3/114.3/116.3 与 api.github.com 可直连；沙箱代理 127.0.0.1:11445 对 github.com 返回 502
- 推送可用：`git -c http.curloptResolve=github.com:443:<IP> -c http.proxy= -c https.proxy= push origin master`（需在沙箱外执行）；IP 会变动，按 140.82.113.3 → 112.3 → 114.3 → 116.3 依次试（2026-11-08 实测 113.3 可用、114.3 已不稳定）
- 无本地 SSH key；gh token 无 admin:public_key scope

## 协议关键事实（实机验证过，勿凭印象改）
- VID 0x093A，usagePage 0xFF05/usage 0x0001，Feature Report ID 9，**数据区固定 8 字节**（HID 描述符确认；Windows HidD_GetFeature 缓冲区必须等于报告长度，超长读取失败——电量 bug 的根因）
- 写 0x01-0x08 ↔ 读 0x81-0x88 对称；0x87 宏不可回读（全 0xFF）；硬件仅 1 个板载配置
- 0x8F 型号信息：buf[1]==1 标志；buf[2] 型号码（3=G24 等）；buf[3]==2 → 8K 接收器；传感器字节有线 buf[4]/无线 buf[5]，241=PAW3950
- LOD：PAW3950 旋转映射 [2,0,1]（UI 0→hw2,1→hw0,2→hw1），源自官方 apply 流程；非 3950 直传
- 回报率：非 8K/有线 2000Hz+ 被硬件钳制 1000Hz；clampRate 应用层预钳，deviceInfo 读不到时不钳
- **电量主通道 = 设备主动上报 Input Report**（parseStatusPush：b0=电量|充电位128, b1=回报率索引|DPI索引<<4, b2=配置序号<<6）；0x89 轮询只作补充，电量在 buf[1]（>128 表充电减 128）。官方 UI「电量同步中」= 等推送
- **DPI 灯色 = 命令 2 的 buf[4..6]（R,G,B）**：实测三个字节可写且持久（写 0x5A 能回读），buf[7] 是 X/Y 轴标志（不持久）。
  官方网页驱动把这三字节恒填 0，所以官方 UI 改了也不生效；本工具已实现 `buildSetResolution(index, hwValue, flag, color)`
- 本体 DPI 键那颗指示灯（实测会亮红）不可设置：`0x0A` 及 0/1/3~8、各种复合包都点不亮；官方 v1.3.7 原生驱动
  下发全量配置时也没有任何灯效命令 → 固件行为，别再拿 0x0A 当它的命令

## 稳定性铁律（都踩过坑，改代码时别破坏）
- **HID 设备必须挂 `error` 监听**：加了 `data` 监听后 node-hid 会开后台读线程，拔出瞬间 emit error，不监听就弹"主进程未捕获异常"（0x48F = 设备已断开）
- **设备枚举缓存必须能失效**：切 8K/有线无线模式会重新枚举、接口 path 全变，旧 path 打开报 0x2。`invalidateCache()` + 打开失败时强制重枚举重试
- `handleDeviceGone(err, sourceDevice)` 要按实例判定，否则旧句柄的迟到错误会误清刚建立的新连接
- **style.css 没有全局 `.hidden`**，只有 `.spinner.hidden` 等组件专属规则；新组件用 hidden 类必须自己写 `.xxx.hidden { display:none }`（toast 曾因此永不消失）
- 回报率码表顺序是硬件编码（1000/500/250/125/8000/4000/2000），展示要按 hz 排序

## .ict/.icm 格式坑（config-format.js）
- .ict key[] 是 UI 顺序 [左右中前进后退DPI]，App 是矩阵顺序 → ICT_TO_APP_INDEX=[0,1,2,4,3,5]
- 官方 looptype 1/2/3 = 硬件 loopType 0/1/2；dpicolor 是 0xBBGGRR 整数
- 宏键 itemdata 官方存宏库 uid，本工具写槽位号（本工具往返无损，官方导入宏键可能解析不到）

## 代码约定（新增，2026-11-13）
- 安装器是独立子项目 `installer/`：`npm run setup` = 同步载荷 + 打 portable + 收到 `dist/`；
  应用本体用 `npm run dist`（产出 NSIS 版留作备用，命名带 `-NSIS-`）
- 安装器里所有 fs 操作用 `require('original-fs')`（Electron 的 fs 会把 .asar 当目录，复制会 ENOENT）
- 安装器所有外部程序调用走 `execFileSafe`，失败只降级成警告，绝不中断安装
- 键位显示名走 `src/shared/keynames.js`（pure，preload 暴露 `window.keynames.keyLabel(kind,value)`）；**协议值永远是原始枚举名**，只翻显示
- 品牌资产源在 `build/assets-src.html`，`npm run assets` 用 Electron 渲染生成 `build/generated/*`（ico/bmp），改视觉后重跑再 `npm run dist`
- NSIS 已改 `oneClick:false` + `allowToChangeInstallationDirectory`，产物名 `Incott-Mouse-Driver-Setup-${version}.exe`
- 启动 electron 前必须 `unset ELECTRON_RUN_AS_NODE`（否则 `whenReady` 报 undefined）
- 电量读到 `level === 0` 视为无效（休眠回显），不要再当 0% 显示

## 灯效 & 渲染层自检（2026-11-14）
- **本体不是"无灯珠"**：DPI 键处有一颗指示灯（固件控制，切换档位时短暂亮起），不可设置；每档 DPI 的颜色走命令 2 的 buf[4..6]
- 灯效页只设 8K 接收器指示灯（命令 8 三模式）；接收器命令无颜色/亮度参数，配色由固件按回报率/电量决定，不要做颜色选择器
- 断开/掉线回调要同时刷 `renderLighting()`，否则灯效页停在可点状态（曾漏）
- 验证渲染层用离屏截图：`show:false` 窗口**不重绘**（capturePage 只给首帧），必须 `offscreen:true` + 监听 `paint` 存帧；
  假 preload 必须 `sandbox:false`；语言切换要触发 `onLangChanged` 才走 renderAll；启动前 `unset ELECTRON_RUN_AS_NODE`

## UI 栅格约定（2026-11-14「所有方框左右对齐」）
- 只认两个变量：`--page-pad`（26px / 窄屏 18px）、`--scrollbar-w`（10px）。`.content` 有 `scrollbar-gutter: stable`，
  所以内容区右边界 = 窗口右 − pad − scrollbar；**`.bottombar` 右内边距必须写 calc(pad + scrollbar)**，否则底栏按钮和卡片差 16px
- **禁止给页面级容器加 `max-width`**（灯效页曾写死 780px，右边缘短 190px）；两列页统一用 `.perf-grid`（等宽/等距/`stretch` 等高）
- 不要做嵌套滚动容器（滚动条会吃掉 10px → 里面的行卡比外面方框窄）；宏列表已改由页面整体滚动
- 回归脚本 `%TEMP%\incott-shot\verify.js`：逐页断言左右外框 == 内容区、底栏按钮齐平、两列等宽、无横向溢出，多窗宽 + 中英文

## 用户偏好
- **所有操作后台执行**：不弹窗、不抢焦点。验证 GUI 优先用静态手段（解析 PE/配置文件/脚本断言），必须开窗口时放最后并先说明；用户游戏/全屏时禁止启动安装器和模态框。
- 用户的鼠标：Incott G24 8K 无线（PID 0x522C，PAW3950）
- 托盘 UX 需求（已确认）：单击/双击呼出窗口、右键菜单常驻电量、开机自启静默（--background）而手动运行必弹窗、DPI 切换弹提示、托盘图标按电量绿/黄/红变色
