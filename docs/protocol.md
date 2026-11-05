# Incott 鼠标 HID 协议（逆向整理）

> 来源：从 Incott 网页驱动（`incott.net/mouse`，GitHub 离线镜像 `oexi/incott-driver-offline`）的
> 混淆 JS 中反混淆还原。所有命令为 8 字节 Feature Report，report ID = 9。

## 1. 设备识别

| 项 | 值 |
|---|---|
| VID | `0x093A`（PixArt 原相） |
| PID 有线 | `0x622C`（25132） |
| PID 无线 | `0x522C`（21036） |
| usagePage | `0xFF05`（vendor-defined） |
| usage | `0x0001` |

> **Col02 接口**：插线充电时 `0xFF05` 会同时出现 Col01/Col02 两个接口（usage 均为 `0x0001`）。
> Col01 发送 Feature Report 会失败（`HidD_SetFeature` 报错），必须用 Col02（枚举靠后的那个）通信。
> 无线时通常只有一个接口。见 `src/main/hid.js` 的 `openDevice`（逐个尝试、Col02 优先）。

传感器（由 `0x8F` 型号信息读取，有线取 buf[4] / 无线取 buf[5]）：
- 字节值 `240`（或未知）= PAW3395（最大 32000 DPI）
- 字节值 `241` = PAW3950（最大 45000 DPI，14672 十进制）
- 内部表示沿用 `0x3395` / `0x3950`（见 `protocol.js SENSOR` / `parseModelInfo`）

无线判定：`productId === 0x522C`。

## 2. 通信机制

- 所有配置通过 **HID Feature Report** 收发，**report ID = 9**。
- 发送：`sendFeatureReport(9, data)`，`data` 为 8 字节 `[cmd, p1..p7]`。
- 接收：`receiveFeatureReport(9)`，返回数据区（含命令码回显）。
- 即时命令（宏分块上传等）另走 `sendReport(9, data)`（Output Report）。

WebHID → node-hid 适配：
| WebHID | node-hid |
|---|---|
| `sendFeatureReport(9, data)` | `device.sendFeatureReport([9, ...data])` |
| `receiveFeatureReport(9)` | `device.getFeatureReport(9, LEN)`（LEN 待实机确认，暂定 8） |
| `sendReport(9, data)` | `device.write([9, ...data])` |

## 3. 命令表（byte 0 = 命令码）

### 3.1 轮询率 `[1, val, 0,0,0,0,0,0]`
`val` → 频率：`0=1000, 1=500, 2=250, 3=125, 4=8000, 5=4000, 6=2000`（Hz）

> **硬件钳制（实机验证）**：有线 / 非 8K 接收器上请求 2000/4000/8000Hz 会被固件钳制为 1000Hz
> （写后回读 0x81 证实）。应用层在写入前按 0x8F 读到的接收器类型预钳制（`protocol.js clampRate`）。

### 3.2 DPI 档位值 `[2, ix, dL, dH, 0,0,0, flag]`
- `ix`：档位索引
- `dL/dH`：DPI **硬件值**（16 位小端），硬件值 = `(实际DPI - 50) / 50`
- `flag`：`0`=单档；XY 分离时 `1`=X 轴第一段、`2`=Y 轴第二段（需分两次发送，中间 sleep 100ms）

> **注意**：DPI 独立 X/Y 在 G24 固件上未得到实机证实（axis=0/1/2 读取均返回同一值），XY 分离按实验性功能对待。

### 3.3 DPI 档位切换 `[3, levels, curDpi, 0,0,0,0,0]`
- `levels`：档位总数
- `curDpi`：当前档位索引

### 3.4 传感器高级 `[4, sub, val, 0,0,0,0,0]`
| sub | 含义 | val |
|---|---|---|
| 1 | LOD 抬升距离 | `0=0.7mm, 1=1mm, 2=2mm`；**PAW3950 需旋转映射**：UI 0→hw 2, UI 1→hw 0, UI 2→hw 1（官方 apply 流程原样行为，见 `protocol.js lodToHw`） |
| 2 | Ripple 波纹 | 0/1 |
| 3 | Angle Snap 角度吸附 | 0/1 |
| 4 | Motion Sync 运动同步 | 0/1 |
| 5 | Sensor Mode | 见 3.8 |

### 3.5 杂项 `[5, sub, ...]`
| sub | 含义 | 参数 |
|---|---|---|
| 1 | 去抖时间 Debounce | `[5,1,t]`，t ≤ 30 |
| 2 | 火力键参数 | `[5,2,lp,t]`，lp=循环次数(≤3)，t=间隔 |
| 3 | 睡眠时间 | `[5,3,tL,tH]`，16 位（最小 10） |

### 3.6 按键映射 `[6, index, k1,k2,k3,k4, 0,0]`
- `index`：按键矩阵位置（0=左键,1=右键,2=中键,3=后退,4=前进,5=DPI键）
- `k1..k4`：32 位键码（小端，k1 最低字节）

### 3.7 宏分块上传 `[7, ict, i, 32, bID, 0,0,0]`
- 宏数据 320 字节，分 10 块，每块 32 字节，用 Output Report（`sendReport`）上传
- `ict=10`（块数），`i`=当前块，`bID`=宏槽位

### 3.8 接收器 LED `[8, mode, 0,0,0,0,0,0]`（8K 接收器专用）

### 3.9 Profile 切换 `[6, 9, index, 0,0,0,0,0]`

> **真相（原版 gvarG23 注释证实）**：硬件只有 **1 个板载配置**。网页驱动界面上的「4 个板载」
> 其实是 PC 端保存的预设，切换时把整套配置「灌入」鼠标；matrix 9 写入的只是当前配置的
> 索引标记。因此若硬件位置 9 有按键，配置序号需另找存储位置。

## 4. 读取命令（byte 0 = 命令码，回显在数据区 byte 0）

**写命令 `0x01`~`0x08` 对应读命令 `0x81`~`0x88`**（Caldis G24 有线实机验证，54 条参数扫描 51 条符合），
另有 `0x89` 状态 / `0x8E` 配对 / `0x8F` 型号信息三条独立读命令。
（历史文档用十进制 131~143 即十六进制 0x83~0x8F，两者一致。）

| 命令码 | 用途 | 返回关键字段（已剥离 reportId） | 实机验证 |
|---|---|---|---|
| `0x81` | 回报率 | buf[1] = 回报率索引 | 125~1000Hz 写后回读成功；**2000/4000/8000 被硬件钳制为 1000**（有线/非 8K 接收器） |
| `0x82,slot` | 单档 DPI | buf[2..3] = 硬件值（16 位小端），DPI = (raw+1)×50 | 50/1600/32000 成功 |
| `0x83` | 档数及当前档 | buf[1]=count, buf[2]=active | 六档回读成功（原版网页驱动 `readDpiInfo` 取错字节 3/2，实际在 1/2） |
| `0x84,sub` | 传感器参数 | buf[2] = 值 | LOD/波纹/直线/MotionSync/传感器模式全部回读成功 |
| `0x85,sub` | 消抖/连发/休眠 | sub1: buf[2]；sub2: buf[2]=loops, buf[3]=interval；sub3: buf[2..3] 16 位秒 | 消抖 0/8/30ms、连发 loops 0~3 成功；无线休眠未实测 |
| `0x86,matrix` | 按键映射 | 32 位键码 = buf[5]<<24\|buf[4]<<16\|buf[3]<<8\|buf[2] | 11 种鼠标功能、普通键、Ctrl+A、播放/暂停、静音回读成功 |
| `0x87` | 宏内容 | **该固件返回 8 个 0xFF（宏不可回读）** | 发送成功 ≠ 回读成功 |
| `0x88` | 接收器 LED | buf[1] | 8K 接收器功能，未实测 |
| `0x89` | 完整状态 | buf[1]=电量 0-100（>128 表充电中，减 128）/档位/回报率索引/当前 DPI | 读取成功；原版电量向下取整到十位 |

> **电量主通道是设备主动上报（Input Report）**：电量/回报率/DPI/板载配置变化时设备推送状态包，
> 布局 `b0=电量|充电位128, b1=回报率索引|DPI索引<<4, b2=配置序号<<6`（见 `parseStatusPush`）。
> 官方 UI 的「电量同步中」即等待推送；0x89 轮询只作补充。
> 注意：Feature Report 9 数据区固定 8 字节（HID 描述符确认），不可按 64 字节读所谓「电压字段」
> ——Windows `HidD_GetFeature` 要求缓冲区等于报告长度，超长读取会失败或返回填充数据。
| `0x8E,1` | 配对状态 | buf[6]==1 表示在线 | 原版配对按钮为空函数，无可用配对实现 |
| `0x8F` | 型号信息 | buf[1]=1 标志；buf[2]=型号码；buf[3]=接收器类型（**2=8K**）；传感器字节：**有线 buf[4] / 无线 buf[5]**，**241=PAW3950**，否则 PAW3395 | G24、PAW3950 识别成功 |

型号码：1=Ghero, 2=G23, 3=G24, 6=G29, 8/14=G23V2, 9=FM23（`protocol.js MODEL_TABLE`）。

> 读取流程：发送 `[cmd, flag...]` → sleep 25~50ms → `getFeatureReport(9)` → 校验返回 byte 0 == cmd。
> Feature Report 数据区就是 **8 字节**（HID 描述符确认，hidapi 总长传 9 = 1 reportId + 8 数据），不要假设 32 字节。

## 5. 键码编码（32 位，`kf_hw` 返回值）

### 5.1 鼠标键
| 功能 | 键码 |
|---|---|
| 左键 | `0x00F00001` |
| 右键 | `0x00F10001` |
| 中键 | `0x00F20001` |
| 前进 | `0x00F40001` |
| 后退 | `0x00F30001` |
| DPI 循环 | `0x00030007` |
| DPI+ | `0x00010007` |
| DPI- | `0x00020007` |
| Profile 切换 | `61706` (0xF10A) |
| 火力键 | `0x0218F00A` |
| 禁用 | `0` |

### 5.2 键盘键
- 无修饰：`(minor & 0xFF) << 8 | 0x80`（minor 为 HID 键码，见 HID 键码表）
- 有修饰：`(minor & 0xFF) << 16 | (modifier & 0xFF) << 8`
- 修饰键位掩码：CtrlL=1, ShiftL=2, AltL=4, WinL=8, CtrlR=16, ShiftR=32, AltR=64, WinR=128

### 5.3 多媒体键（格式 `0xXXYY0003`）
PLAYER=`0x01830003`, PLAYPAUSE=`0x00CD0003`, STOP=`0x00B70003`,
PREVIOUS=`0x00B60003`, NEXT=`0x00B50003`, VOLINC=`0x00E90003`, VOLDEC=`0x00EA0003`,
MUTE=`0x00E20003`, EMAIL=`0x018A0003`, CAL=`0x01920003`, EXPLORER=`0x01940003`,
HOME=`0x02230003`, REFRESH=`0x02270003`, FORWARD=`0x02250003`, BACK=`0x02240003`,
SEARCH=`0x02210003`

### 5.4 宏
`index << 16 | 9`（index 为宏槽位）

## 6. 宏数据格式（320 字节）

```
[0]     = 槽位 bufferID
[1]     = 循环类型：0=按住循环, 1=任意键停止, 2=循环N次
[2..3]  = 循环次数（16 位）
[4..]   = 宏项（每项 4 字节）：[press?0:128 | 1, HID键码, 延迟低, 延迟高]
[288..293] = "Macro"+编号 标记
[304..307] = size（32 位，=(项数+1)*4+128）
[312..315] = uid（32 位）
[316..317] = 项数*2
[318]     = 项数
```

## 7. DPI 映射

- 硬件值 = `(实际DPI - 50) / 50`（线性，步进 50）
- PAW3395：50 ~ 32000（硬件值 0 ~ 639）
- PAW3950：50 ~ 45000（硬件值 0 ~ 899）

## 8. 应用流程（apply）

按序发送（每步之间 sleep ~200ms）：
1. 按键映射（火力键、宏、普通键）
2. DPI 档位值（setResolution，XY 分离时分两次）
3. DPI 档位切换（setDif）
4. 轮询率（setRte）
5. 传感器模式（setSM）
6. LOD（setLD）
7. 波纹/角度吸附/运动同步（setRi/setFix/setMt）
8. 接收器 LED（setReceiverLED）
9. 去抖（setDce）
10. 睡眠时间（setSep）
11. Profile 切换（setProfileIndex）
