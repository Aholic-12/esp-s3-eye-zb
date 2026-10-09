# Week1 · 开发板 IMU 采集 → VPS → Web 展示

一个**能跑通、能验证、能解释**的最小系统。板端只做一件事：读真实 IMU（三轴加速度 + 三轴陀螺仪），
打上时间戳，通过 WiFi POST 到自己的服务器；服务器落盘原始记录并提供查询接口；网页只读展示。

```
ESP32 ──HTTP POST /api/ingest──► Node 服务 ──append──► data/records.ndjson
   │                               │                        ▲
   │ 采样 + 时间戳                  │ /api/latest            │ 唯一可信记录
   └── 不存历史、不做业务            └──► 浏览器页面（只读展示，不改写任何值）
```

---

## 0. 目录结构

```
esp32-sensor-web/
├── firmware/                     ← 板端（PlatformIO + Arduino）
│   ├── platformio.ini            两个编译目标：esp32s3eye / esp-eye
│   ├── include/
│   │   ├── config.example.h      配置模板
│   │   └── config.h              ★ 你要改的就是这个（WIFI / 服务器地址 / 设备ID）
│   └── src/main.cpp              扫描 I2C → 识别 IMU → 采样 → 上报
├── server/
│   ├── server.js                 零依赖 Node 服务（接收/落盘/查询/静态托管）
│   └── data/records.ndjson       运行后自动生成：一行一条原始记录，append-only
├── web/index.html                展示页面（单文件，无外部依赖）
├── tools/
│   ├── simulate_device.js        模拟设备（联调用，数据是假的，不可当证据）
│   ├── smoke_test.js             服务端全链路冒烟测试（28 项断言）
│   └── page_check.js             页面静态自检（不需要浏览器）
├── deploy/
│   ├── sensor-web.service        systemd 单元
│   └── nginx-sensor-web.conf     可选：域名 + HTTPS 反代
└── .gitignore
```

---

## 1. 五分钟先跑通服务端（不接板子）

```bash
cd server
node server.js                     # 默认 8080 端口，token = dev-token-please-change
```

另开一个终端：

```bash
node tools/smoke_test.js           # 应当看到「通过 28 项，失败 0 项」
```

浏览器打开 <http://127.0.0.1:8080/>，此时页面应显示 **无数据**（红色）—— 这正是"无数据状态"的正确表现。

想看有数据的样子（**仅用于联调，不能作为作业证据**）：

```bash
node tools/simulate_device.js --device g01-s3eye --count 60
```

刷新页面：数值、曲线、原始记录表都会动起来。清理假数据：删掉 `server/data/records.ndjson` 即可。

---

## 2. 硬件与接线

> **固件会自动识别 IMU，且优先选带陀螺仪的六轴芯片。** 你不用先告诉它是什么型号 ——
> 上电后串口会打印 I2C 扫描结果和命中的芯片名。**判断有没有陀螺仪，只看串口日志这一行。**

### 情况 A：ESP32-S3-EYE（板载 IMU）

| 项 | 值 |
|---|---|
| 板载 IMU | **QMA7981** 三轴加速度计（I2C 地址 `0x12`，芯片 ID `0xE7`） |
| I2C 引脚 | **SDA = GPIO4，SCL = GPIO5** |
| 量程配置 | ±2g，4096 LSB/g |
| 陀螺仪 | **没有**（页面 gyro 列会显示 `n/a`） |
| 串口 | USB 直连，无需 CH340/CP2102，日志走 USB Serial/JTAG |

> ⚠️ **QMA7981 只有加速度计，没有陀螺仪** —— 这是乐鑫官方 BSP / 原理图确认的事实。
> 如果你要陀螺仪，看情况 B。

### 情况 B：要陀螺仪 —— 外接一个六轴 IMU（推荐 MPU6050）

把模块接到 **同一条 I2C 总线** 上（板载 IMU 和它共用总线，互不冲突）：

```
MPU6050 模块        ESP32-S3-EYE / 通用 ESP32
 VCC  ────────────  3V3
 GND  ────────────  GND
 SDA  ────────────  GPIO4（S3-EYE）  /  GPIO21（通用 ESP32、ESP-EYE）
 SCL  ────────────  GPIO5（S3-EYE）  /  GPIO22（通用 ESP32、ESP-EYE）
```

- 挂在 **ESP32-S3-EYE** 上 → `config.h` 引脚保持 `4 / 5` 不动；
- 挂在 **通用 ESP32 / ESP-EYE** 上 → `config.h` 改成 `I2C_SDA_PIN 21`、`I2C_SCL_PIN 22`。

上电后串口应打印 `[I2C] 扫描到 2 个设备: 0x12 0x68`，随后
`[IMU] 命中 MPU6050/MPU6000 @0x68 ... 三轴加速度 + 三轴陀螺仪` —— **因为六轴优先，它会盖过板载的 QMA7981**。

### 情况 C：ESP-EYE（老款）

ESP-EYE 只有摄像头 + 数字麦克风，**板上一个 IMU 都没有**，必须外接（接法同上，用 GPIO21/22）。

### 固件支持的 IMU 一览

| 器件 | 地址 | 加速度 | 陀螺仪 |
|---|---|---|---|
| **InvenSense 家族** MPU6000/6050/6500/9250/9255/6886、ICM-20602/20608-G/20689 | 0x68 / 0x69 | ✅ ±2g | ✅ ±250dps |
| **ST 家族** LSM6DS3 / LSM6DSL / LSM6DS3TR-C / LSM6DSO / ISM330DLC / ASM330LHH / LSM6DSV | 0x6A / 0x6B | ✅ ±2g | ✅ ±245dps |
| **Bosch BMI160** | 0x68 / 0x69 | ✅ ±2g | ✅ ±2000dps |
| **QMI8658** | 0x6A / 0x6B | ✅ ±2g | ✅ ±256dps |
| **QMA6100P**（本组实测板子上的就是它，ID `0x90`） | 0x12 | ✅ ±2g | ❌ |
| QMA7981（ID `0xE7`） | 0x12 | ✅ ±2g | ❌ |
| ADXL345 | 0x53 | ✅ ±16g | ❌ |

> 📌 **实测记录**：本组这块板子的 IMU 是 **QMA6100P**（`0x12` / ID `0x90`），
> 不是常见的 QMA7981（ID `0xE7`）——两者引脚兼容但寄存器布局不同，固件里已分别处理。
> 二者**都没有陀螺仪**。要六轴必须外接 MPU6050 等。

**一个都不认识怎么办？** 串口会打印一张「探针表」（每个地址的 `WHO_AM_I` 取值），
把那张表贴出来就能一眼看出是什么芯片；对照表就印在日志里。

---

## 3. 板端：编译烧录

> **第一次烧录、或者不确定怎么装工具链？看 [`docs/FLASH.md`](docs/FLASH.md)** —— 从装 PlatformIO、
> 装驱动、进下载模式到常见报错，手把手写好了。下面是速查版。

```bash
cd firmware

# 1) 改配置（这一步必须做）
#    include/config.h 里改四处：
#      WIFI_SSID / WIFI_PASSWORD        → 你的 2.4GHz WiFi
#      SERVER_INGEST_URL                → http://<电脑或VPS的IP>:8080/api/ingest
#      DEVICE_TOKEN                     → 必须和服务端一致
#      DEVICE_ID                        → 全班唯一，例如 g03-s3eye

# 2) 编译 + 烧录 + 看日志
pio run -e esp32s3eye -t upload
pio device monitor -e esp32s3eye -b 115200
```

**串口日志应该长这样**（这段日志本身就是"认识设备"环节的产物）：

```
[BOOT ] fw=week1-1.1 board=ESP32-S3-EYE dev=g01-s3eye
[I2C  ] 扫描到 1 个设备: 0x12
[IMU  ] 命中 QMA7981（三轴加速度计，无陀螺仪）  ±2g / 4096 LSB/g
[WIFI ] 正在连接 ssid="myap" ...
[WIFI ] 已连接  ip=192.168.1.30  rssi=-52 dBm
[TIME ] NTP 对准，板端 UTC = 1760000000
[READY] 开始采样，服务端 = http://192.168.1.100:8080/api/ingest
[DATA ] #1 accel=(0.011,-0.022,0.999)g mag=1.0032g  gyro=n/a  -> HTTP 201 (ok=1)
[DATA ] #2 accel=(0.014,-0.019,1.001)g mag=1.0031g  gyro=n/a  -> HTTP 201 (ok=2)
```

**识别不到 IMU 时**固件不会造假数据，而是每 5 秒重扫一次 I2C 并打印排查提示 —— 方便你边插线边看结果。

`platformio.ini` 里两个目标怎么选：

```bash
pio run -e esp32s3eye -t upload     # ESP32-S3-EYE（默认）
pio run -e esp-eye    -t upload     # ESP-EYE / 通用 ESP32
```

---

## 4. 服务端：从本机到 VPS

### 4.1 本机联调

```bash
cd server
node server.js
ipconfig            # Windows 看 IPv4 地址；Linux/mac 用 ip addr / ifconfig
```

把板端 `SERVER_INGEST_URL` 指向 `http://<那个IP>:8080/api/ingest`，
并确认 Windows 防火墙允许 8080 入站（第一次运行会弹窗，选"允许"）。

### 4.2 部署到 VPS

```bash
# --- 本地：把代码传上去（不含 data 和 config.h）---
rsync -av --exclude node_modules --exclude data ./ user@<VPS-IP>:/opt/esp32-sensor-web/

# --- VPS 上 ---
ssh user@<VPS-IP>
sudo apt update && sudo apt install -y nodejs git        # 需要 Node >= 18
sudo useradd -r -s /usr/sbin/nologin sensor
sudo mkdir -p /var/lib/sensor-web && sudo chown -R sensor:sensor /var/lib/sensor-web
sudo chown -R sensor:sensor /opt/esp32-sensor-web

# 编辑 deploy/sensor-web.service，把 DEVICE_TOKEN 改成你自己的长随机串
sudo cp /opt/esp32-sensor-web/deploy/sensor-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sensor-web
journalctl -u sensor-web -f          # 看启动日志

# 只对外暴露服务（不用 nginx 就开这个）
sudo ufw allow 8080/tcp

# 想做域名 + HTTPS 就再装 nginx，见 deploy/nginx-sensor-web.conf
```

**上 VPS 前必须做的两件事**（不做的后果：任何人都能往你的库灌数据）：

1. 改 `DEVICE_TOKEN`，设成一个长随机串，服务端和 `config.h` 两边一致：
   ```bash
   openssl rand -hex 24
   ```
2. 确认 `data/records.ndjson` 的权限是 `sensor` 用户可写，而别人读不到 WiFi 密码
   （WiFi 密码只在板子上，服务器不存，这点是安全的）。

### 4.3 接口一览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/ingest` | 板端上报，需 `X-Device-Token` 头 |
| GET | `/api/latest?device=<id>` | 最新一条 + `age_ms`（数据年龄） |
| GET | `/api/history?device=<id>&limit=120` | 最近 N 条，画曲线用 |
| GET | `/api/devices` | 设备列表 + 每条记录数 |
| GET | `/api/health` | 服务状态、已收条数、记录文件路径 |
| GET | `/api/export.csv?device=<id>` | 导出 CSV（交作业用） |
| GET | `/` | 展示页面 |

---

## 5. 当堂验证清单

按顺序做，每一步都能看到明确现象。**先看串口，再看页面** —— 出问题时能立刻分清是板端还是服务端。

| # | 动作 | 预期现象 | 不通过说明什么 |
|---|---|---|---|
| 1 | 上电，看串口 | 打印 `[I2C] 扫描到 …` + `[IMU] 命中 <芯片名>`，且带陀螺仪的芯片名后写着"三轴加速度 + 三轴陀螺仪" | 没打印 → 传感器没认出来，看第 6 节排错 |
| 2 | 板子**平放静止** | 串口 `mag ≈ 1.000g`（±0.05） | 偏差大 → 量程写错或芯片 ID 不对 |
| 3 | 页面打开 | 大数字 ≈ 1.00 g，徽章显示**数据实时**（绿） | 显示"无数据" → 板端没上报成功 |
| 4 | 把板子翻个面 | `accel_z` 变负，但 `|a|` 仍然 ≈ 1 g | 合矢量跟着变 → 算错了合矢量公式 |
| 5 | 用手快速晃动板子 | `|a|` 明显偏离 1 g；有陀螺仪的板子 gyro 冲到几十~几百 dps | gyro 一直 0 → 该板无陀螺仪或陀螺仪没初始化 |
| 6 | SSH 上去 `tail -f /var/lib/sensor-web/records.ndjson` | 每秒蹦出一行 JSON，`server_iso` 是当前时间 | 没有新行 → 服务端没收到，查 token 和 URL |
| 7 | **核对时间** | 页面"板端时间"(NTP) 与"服务端时间"相差 < 2 秒 | 板端时间是 1970 → NTP 没对准（防火墙挡了 UDP 123） |
| 8 | **短按 BOOT 键** | 串口打印 `[PAUSE] 采样已暂停`；页面停止刷新，徽章转**数据迟滞**→**未更新**，但**旧数值和旧时间原样保留** | 页面数字消失/变 0 → 页面把"无新数据"错误地当成了"值为 0" |
| 9 | 再按一次 BOOT | 恢复采样，序号继续往上走 | 序号从 1 重新开始 → 重启了（看串口是否有复位日志） |
| 10 | `curl http://<host>:8080/api/latest?device=<你的ID>` | 返回的 `value` 和页面上的数字**完全一致** | 不一致 → 页面写死了数值，必须改掉 |

**第 10 步是最关键的一条**：页面所有数字都来自接口返回，`web/index.html` 里没有任何硬编码的测量值，
页面底部还直接列出服务端 NDJSON 的最后 8 条原始记录供比对。

### 证明"数据来自本组设备"

三条独立证据，缺一不可：

1. **MAC 地址**：页面"MAC"字段 = 你板子的 MAC（`WiFi.macAddress()`），每组不同；
2. **设备 ID**：`config.h` 里的 `DEVICE_ID` 是你自己起的，服务端按它分设备存储；
3. **来源 IP**：`src_ip` 是板子在局域网里的 IP，和你的路由器 DHCP 列表能对上。

停采后这些字段不会被清掉 —— 页面展示的是**最后一次真实观测**，不是实时伪造。

---

## 6. 排错表（嵌入开发典型坑）

| 现象 | 原因 | 怎么修 |
|---|---|---|
| `pio device monitor` 一片乱码 | 波特率不对 | 加 `-b 115200`；ESP32-S3-EYE 还要确认 `ARDUINO_USB_CDC_ON_BOOT=1` |
| 烧录报 `Failed to connect` | 没进下载模式 / 串口被占用 | 按住 BOOT 再按 RST 松开，然后重新 upload；关掉其他串口工具 |
| S3-EYE 烧完不停重启 | 板子没有 USB-UART 桥接，出问题后难进下载模式 | 按住 BOOT 上电再烧；确认 `board_build.arduino.memory_type = qio_opi` |
| 串口刷屏 `[IMU] 没识别到 IMU` | 接线/引脚/供电问题 | 看同一行上面打印的 `[I2C] 扫描到 …`：空 → 接线问题；有别的地址 → 地址不对 |
| 扫描到 `0x12` 但初始化失败 | 量程寄存器写失败 | 把 `I2C_FREQ_HZ` 从 400000 降到 100000 试 |
| `[WIFI] 连接失败` | 用了 5G SSID / 密码错 / 信号弱 | ESP32 只支持 **2.4GHz**；`rssi` 低于 -80 就该靠近路由器 |
| `[DATA] 上报失败 code=-1` | 网络不通 | 板子和服务器要在同一网段；确认服务器 URL 的 IP 和端口 |
| `code=401` | token 不一致 | `config.h` 的 `DEVICE_TOKEN` 必须等于服务端环境变量 |
| `code=404` | URL 路径写错 | 必须是 `.../api/ingest`，别漏 `/api` |
| 页面显示"无数据"但串口一直 HTTP 201 | 页面选的设备不对 | 用左上角下拉框切到你 `DEVICE_ID` 那个设备 |
| 页面"数据年龄"一直是几十秒 | 板端 `SAMPLE_INTERVAL_MS` 调太大了 | 改回 1000 |
| 板端时间显示"（NTP 未对准）" | UDP 123 被防火墙挡了 | 换 `NTP_SERVER_1`；或接受它，只用服务端时间 |
| 加速度值整体偏大/偏小 4 倍 | 量程定义和实际不符 | QMA7981 是 14 位左对齐，代码里已 `>>2`；换板子要同步改 `g_accelLsbPerG` |

**关于 USB 桥接**：本工程是**板子独立联网**上报的（走 ESP32 自己的 WiFi）。
如果哪天为了排错改成"USB 串口转发到电脑再上报"，那只能定位问题，
**不能**据此认定"开发板独立联网上传通过" —— 当堂验证必须拔掉 USB 数据线（只留供电）还能持续出数。

---

## 6.5 两个诊断模式（认不出芯片 / 连不上 WiFi 时用）

这两个模式把"猜"变成"看"。实测中就是靠它们定位到板子上的 IMU 其实是 QMA6100P。

### ① I2C 诊断：把芯片的全部寄存器 dump 出来

```bash
cd firmware
pio run -e diag -t upload --upload-port COM4     # 换成你的串口
python ../tools/read_serial.py -p COM4 -s 18 --reset
```

它会拿 **100kHz 和 400kHz 两个速度**各扫一遍（用来排除"线太长/上拉不够"导致的时序问题），
然后把每个应答设备 `0x00~0x7F` 的寄存器全部打印出来。看到 `0x00` 的值就能对号入座：

| 0x00 处的值 | 芯片 |
|---|---|
| `0x90` | **QMA6100P**（无陀螺仪） |
| `0xE7` | QMA7981（无陀螺仪） |
| `0x05` | QMI8658（有陀螺仪） |
| `0xD1` | BMI160（有陀螺仪） |
| `0x68`/`0x70`/`0x71`/`0x19` | MPU6050 / 6500 / 9250 / MPU6886（有陀螺仪） |

### ② WiFi 扫描：看板子到底能搜到什么

```bash
pio run -e wifiscan -t upload --upload-port COM4
python ../tools/read_serial.py -p COM4 -s 20 --reset
```

输出示例（实测）：

```
板子搜到 19 个网络：
   1) ssid="Xiaomi_037C"  rssi=-24 dBm  ch=6  2.4G ✅
   ...
结论：配置的 SSID 在扫描结果里 ❌ 没找到 —— 名字写错了，或者根本不是 2.4G 网络
```

**关键点**：ESP32 只能看 2.4GHz。如果你的路由器的 SSID 只开在 5GHz，它**根本不会出现在这个列表里**，
表现就是"密码明明对，却永远连不上"。这时候去路由器后台把 2.4G 打开（或分一个 2.4G 的 SSID）即可。

### 用完记得烧回正式固件

```bash
pio run -e esp32s3eye -t upload --upload-port COM4
```

---

## 7. 提交物清单

| 交付物 | 在哪 |
|---|---|
| 板端代码 | `firmware/src/main.cpp` + `platformio.ini` + `config.example.h` |
| 服务端代码 | `server/server.js` |
| Web 代码 | `web/index.html` |
| 部署入口 | `deploy/sensor-web.service`、`deploy/nginx-sensor-web.conf` |
| 一条真实观测对应记录 | `curl "http://<host>:8080/api/export.csv?device=<你的ID>"` 导出的 CSV，或直接截取 `records.ndjson` 里对应的一行 |
| 个人修改与运行说明 | 本文件的第 3、4 节 + 你自己改过的参数说明 |
| 个人项目要呈现的一项设备数据 | 从第 5 节里选一个你最有把握讲清楚的（建议：`accel_mag` 或晃动时的 `gyro_z`） |

> `firmware/include/config.h` 里含 WiFi 密码，提交前务必替换成 `config.example.h` 的内容。
> `.gitignore` 已经帮你排除它，但**手动打包提交时要再检查一遍**。

---

## 8. 备用路径

**VPS 挂了 / 还没分配空间**：
先用第 4.1 节的本地服务把整条链路走通（板端只要能 POST 到局域网内的电脑，就证明板端独立联网上传是通的）。
此时在报告里明确写：*"部署到 VPS 待补"*，并把本地 `records.ndjson` 作为原始记录留存。
**不要**把"本地能跑"说成"VPS 已验证"。

**传感器一直认不出来**：
换用同组已验证的板卡，或在 `config.h` 里换 I2C 引脚号重试。
实在不行，用 `simulate_device.js` 先把服务端和页面做出完整效果，
但要在报告里明确区分**真实观测**与**模拟观测** —— 模拟脚本的 `fw` 字段是 `SIMULATOR-do-not-use-as-evidence`。

**时间来不及**：
六轴 → 只做 `accel_mag`（主指标）也完全够用，陀螺仪是加分项。曲线、六轴表、原始记录表都可以先留着。

---

## 9. 自己扩展的方向（可选）

- 加 **OLED 显示**：板端把当前值显示在屏幕上，脱离网页也能看
- 加 **离线缓存**：网络断了先存 LittleFS，恢复后补传（对应"失败重传"）
- 加 **阈值告警**：`|a| > 1.5g` 判定为"被搬动"，服务端记录事件
- 换 **MQTT** 替代 HTTP POST：更省电，但要额外跑 broker
- 加 **influxdb + Grafana**：真做长期数据看板时再上
