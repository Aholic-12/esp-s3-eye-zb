# Git / GitHub 推送说明

远端仓库：https://github.com/Aholic-12/esp-s3-eye-zb （分支 `main`）

## 为什么要绕一下

这台机器上 **`github.com:443` 不通**（TCP 超时，DNS 正常，属于网络层封锁），
所以不能用常规的 `https://github.com/...` 推送。

已验证可用的通道：**GitHub 官方的 443 SSH 端口 `ssh.github.com:443`**。

## 本机已做的配置

`~/.ssh/config` 里加了转发规则，让 `git@github.com:xxx` 自动落到 `ssh.github.com:443`：

```
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519
```

配合本仓库的远端地址：

```
origin  git@github.com:Aholic-12/esp-s3-eye-zb.git
```

另外 `~/.gitconfig` 里有一条全局 URL 重写
（`url."https://jihulab.com/esp-mirror/".insteadOf = https://github.com/`，
是拉乐鑫组件用的镜像）。为了不让它把推送也劫持到镜像站，
本仓库局部加了一条更长的同名规则覆盖它：

```
git config url."https://github.com/Aholic-12/".insteadOf "https://github.com/Aholic-12/"
```

## 日常操作

```bash
cd esp32-sensor-web

git add -A
git commit -m "说明这次改了什么"

# 先看有没有误提交敏感文件（重要）
git status --short

git push          # 首次是 git push -u origin main
```

## 推送前的红线

`firmware/include/config.h` 里有 WiFi 密码和 VPS 地址，**已被 `.gitignore` 排除**。
改完代码后如果动过 `config.h`，提交前务必确认：

```bash
git ls-files --cached | grep -c "config.h"     # 只看得到 config.example.h，config.h 不该出现
```

被忽略、不进仓库的还有：`firmware/.pio/`、`server/data/`、`server/node_modules/`、`*.log`。

## 换机器 / 重新克隆

```bash
git clone git@github.com:Aholic-12/esp-s3-eye-zb.git
# 然后把 ~/.ssh/config 里那段 Host github.com 转发规则也加上
```
