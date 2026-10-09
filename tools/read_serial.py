#!/usr/bin/env python3
"""
读取开发板串口日志，采集指定秒数后自动退出（不用手动按 Ctrl+]）。

用法：
    python tools/read_serial.py -p COM4 -s 20

依赖：pyserial（pip install pyserial）
"""
import argparse
import sys
import time

try:
    import serial
except ImportError:
    sys.exit('缺少 pyserial，请先执行：pip install pyserial')


def main():
    ap = argparse.ArgumentParser(description='读串口日志 N 秒')
    ap.add_argument('-p', '--port', default='COM4', help='串口号，如 COM4 / /dev/ttyUSB0')
    ap.add_argument('-b', '--baud', type=int, default=115200, help='波特率，默认 115200')
    ap.add_argument('-s', '--seconds', type=float, default=20, help='采集秒数，默认 20')
    ap.add_argument('-r', '--reset', action='store_true',
                    help='打开后先复位一次板子，好抓到从 [BOOT] 开始的完整日志')
    args = ap.parse_args()

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.2)
    except Exception as exc:                                  # noqa: BLE001
        sys.exit(f'打不开 {args.port}：{exc}\n'
                 f'提示：确认串口号（Windows 看设备管理器），并关掉其他占用它的工具。')

    if args.reset:
        # 标准的 ESP32 硬复位时序（EN 拉低再拉高），别改顺序
        ser.setDTR(False)      # IO0 = HIGH
        ser.setRTS(True)       # EN  = LOW  → 芯片进入复位
        time.sleep(0.2)
        ser.setDTR(True)       # IO0 = LOW
        ser.setRTS(False)      # EN  = HIGH → 芯片启动
        time.sleep(0.05)
        ser.setDTR(False)      # IO0 = HIGH
        time.sleep(0.3)
        ser.reset_input_buffer()
        print('# 已发送复位信号，从 [BOOT] 开始抓 ...\n')

    print(f'# 已打开 {args.port} @ {args.baud}，采集 {args.seconds:g} 秒 ...\n')
    deadline = time.time() + args.seconds
    buf = b''
    try:
        while time.time() < deadline:
            chunk = ser.read(4096)
            if not chunk:
                continue
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                print(line.decode('utf-8', errors='replace').rstrip('\r'))
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()
    print('\n# 采集结束')


if __name__ == '__main__':
    main()
