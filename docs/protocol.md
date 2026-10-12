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

传感器（从 `sensor` 字段读取，值即 PID 的一部分）：
- `0x3395` = PAW3395（最大 32000 DPI）
- `0x3950` = PAW3950（最大 45000 DPI，14672 十进制）

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

### 3.2 DPI 档位值 `[2, ix, dL, dH, 0,0,0, flag]`
- `ix`：档位索引
- `dL/dH`：DPI **硬件值**（16 位小端），硬件值 = `(实际DPI - 50) / 50`
- `flag`：`0`=单档；XY 分离时 `1`=X 轴第一段、`2`=Y 轴第二段（需分两次发送，中间 sleep 100ms）

### 3.3 DPI 档位切换 `[3, levels, curDpi, 0,0,0,0,0]`
- `levels`：档位总数
- `curDpi`：当前档位索引

### 3.4 传感器高级 `[4, sub, val, 0,0,0,0,0]`
| sub | 含义 | val |
|---|---|---|
| 1 | LOD 抬升距离 | `0=0.7mm, 1=1mm, 2=2mm`（PAW3950 需反转映射 0↔2） |
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

## 4. 读取命令（byte 0 = 命令码，回显在数据区 byte 1）

| 命令码 | 用途 | 返回 |
|---|---|---|
| 131 | 读 DPI 档位 | `[131, lv, ix]` → lv=档位数, ix=当前索引 |
| 133,3 | 读电量（无线） | `[133, 3, lo, hi]` → val = hi<<8\|lo |
| 134,index | 读按键映射 | 32 位键码 = d[5]<<24\|d[4]<<16\|d[3]<<8\|d[2] |
| 142,1 | 读配对信息 | d[6]==1 表示在线 |
| 读设备名 | 见 readDps | — |

> 读取流程：发送 `[cmd, flag...]` → sleep 25ms → `getFeatureReport(9)` → 校验返回 byte 1 == cmd。

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
