# Incott Mouse App — 项目长期记忆

## 项目概况
Incott（因科特）鼠标桌面配置工具，Electron + node-hid，不依赖官方网页驱动。
逆向依据：`F:\AI Agent\Reverse Engineer Anything\incott-web-driver-re`（分析报告 + Caldis 实机验证 + oexi 移植版源码）。

## 环境与构建
- Node 在 `F:\AI Agent\nodejs\node.exe`（系统 PATH 未必有，脚本里 `export PATH="/f/AI Agent/nodejs:$PATH"`）
- 测试：`node --test`（当前 31 个全绿）；语法检查 `node --check`
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

## 用户偏好
- 用户的鼠标：Incott G24 8K 无线（PID 0x522C，PAW3950）
- 托盘 UX 需求（已确认）：单击/双击呼出窗口、右键菜单常驻电量、开机自启静默（--background）而手动运行必弹窗、DPI 切换弹提示、托盘图标按电量绿/黄/红变色
