# 把通话中转装到腾讯云轻量服务器

这是一套可以整夹删掉的部署说明。它不改 `call-relay/server.js`，也不改浏览器插件。删掉 `call-relay/deploy/` 之后，中转程序和插件都还是原来的样子。

适合：腾讯云轻量应用服务器（Lighthouse），系统是 Ubuntu、Debian 或 OpenCloudOS，带宽大约 3 Mbps，机器在中国大陆，**还没有完成 ICP 备案的域名**。

先看两件做不到的事：

- 没有备案域名时，只能暂时用「公网 IP + HTTPS」。腾讯云可以随时按未备案网站的规则把 80、443 或你用来对外的端口关掉。这不是 Caddy 能解决的。备案完成之前，把它当成临时办法。
- 插件在 WhatsApp 网页里创建 WebSocket（见仓库 `HANDOFF.md` 第 1 节：脚本是 `@inject-into page`）。`@connect *` 只对 Tampermonkey 自己的 `GM_xmlhttpRequest` 生效，挡不住网页自己的安全策略。如果 WhatsApp 的 `connect-src` 拦住了到这台服务器的 `wss://`，浮层会报错，通话自动改回你的原声。这和中转有没有配好是两件事。

一条通话的音频经过中转，大约不到 1 Mbps。3 Mbps 够一个人打电话。打电话时不要再下大文件。

## 你要在轻量控制台放行的端口

在腾讯云轻量控制台的「防火墙」里加规则。只在服务器里开 `ufw` 不够，控制台那层默认是关的。

| 端口 | 协议 | 要不要对公网开放 | 原因 |
|---|---|---|---|
| 8443 | TCP | 要 | 插件访问 `https://公网IP:8443`。业务只走这里。 |
| 80 | TCP | 要 | Let's Encrypt 用 **http-01** 来验证这台机器真的拥有这个 IP。验证程序访问的是公网 80，不是 8443。 |
| 443 | TCP | 这套临时配置不要 | 官方也允许 **tls-alpn-01**，那个验证打在公网 443。下面的 Caddy 配置关掉了它，所以签发不依赖 443。 |
| 8787 | TCP | 不要 | Node 中转的端口。见下一节。 |

备案之后如果改用域名和 443，再开放 443，并可以关掉 8443。80 仍然要留着，因为域名证书的 http-01 也常用它。

## Node 为什么不能只听本机

`server.js` 只认环境变量 `PORT`（不写就是 `8787`）。`server.listen(port)` 没有主机地址参数，所以进程会听所有网卡（`0.0.0.0`，开了 IPv6 时常常是 `::`）。没有 `HOST=127.0.0.1` 这种开关，这里也不改 `server.js`。

本机的 Caddy 访问 `127.0.0.1:8787` 仍然通。公网进不来，靠的是轻量防火墙**不要放行 8787**。装完后在另一台电脑上确认 `curl http://公网IP:8787/health` 连不上。

## 1. 安装 Node.js 22

这套中转在 Node.js 22 上跑过。用国内镜像，少碰被墙的地址。

先看系统：

```bash
cat /etc/os-release
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y curl xz-utils
cd /tmp
curl -fL -o node.tar.xz https://npmmirror.com/mirrors/node/v22.23.4/node-v22.23.4-linux-x64.tar.xz
sudo tar -xJf node.tar.xz -C /usr/local --strip-components=1
node -v
```

应显示 `v22.23.4`。如果 npmmirror 上这个小版本已经换了，打开 <https://npmmirror.com/mirrors/node/latest-v22.x/>，把命令里的版本号换成页面上的最新 22。

### OpenCloudOS

没有 `apt` 就用 `dnf` 装 `curl` 和 `xz`，上面的 `curl` 和 `tar` 命令一样。`tar` 一般已经有了。

```bash
sudo dnf install -y curl xz
```

## 2. 把中转放到 /opt/call-relay

在你自己的电脑上，这个仓库里的 `call-relay/server.js` 和 `call-relay/wsutil.js` 就是全部程序。没有 `npm install`。

```bash
sudo useradd --system --home /opt/call-relay --shell /usr/sbin/nologin callrelay
sudo mkdir -p /opt/call-relay
sudo cp server.js wsutil.js /opt/call-relay/
sudo chown -R callrelay:callrelay /opt/call-relay
```

`nologin` 在有的系统上是 `/sbin/nologin`。`useradd` 报 shell 找不到时，改成那一个。

不要把 `deploy/` 里的说明当成程序拷进去也行，拷了也没有影响。不要把 API Key 写进这两个 js 文件。

## 3. 环境变量

`server.js` 实际读取的名字只有这些：

| 变量 | 必填？ | 作用 |
|---|---|---|
| `RELAY_KEY` | 必填 | 你自己设的中转密码。插件里的「中转密钥」填同一串。 |
| `DASHSCOPE_API_KEY` | 用百炼时必填 | 百炼的长期 API Key。不要写进插件。 |
| `ALIYUN_WORKSPACE` | 用百炼时必填 | 业务空间 ID，只含字母、数字、下划线、短横线。 |
| `OPENAI_API_KEY` | 可选 | 只有还要用 OpenAI 引擎时才填。 |
| `ALIYUN_MODEL` | 可选 | 不填就是 `qwen3.8-livetranslate-flash-realtime`。 |
| `PORT` | 可选 | 不填就是 `8787`。systemd 单元里会写成 8787。 |

`RELAY_KEY` 必须有。百炼和 OpenAI 至少要配一边：要么 `DASHSCOPE_API_KEY` 加 `ALIYUN_WORKSPACE`，要么 `OPENAI_API_KEY`。

```bash
sudo install -m 600 /dev/null /etc/call-relay.env
sudo editor /etc/call-relay.env
```

文件内容：

```bash
RELAY_KEY=换成一长串自己记得住的密码
DASHSCOPE_API_KEY=百炼控制台创建的长期 Key
ALIYUN_WORKSPACE=业务空间 ID
# OPENAI_API_KEY=sk-可选
# ALIYUN_MODEL=qwen3.8-livetranslate-flash-realtime
```

`chmod 600` 已经在 `install` 里做了。这个文件不要提交到 git。

## 4. 开机自己跑

```bash
sudo cp call-relay.service /etc/systemd/system/call-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now call-relay
sudo systemctl status call-relay --no-pager
curl -fsS http://127.0.0.1:8787/health
```

最后一行应是 `{"ok":true}`。如果 `status` 里是 `node: not found`，看 `command -v node`，把单元文件里的 `ExecStart=` 改成那个路径，再 `daemon-reload` 和 `restart`。

## 5. 安装 Caddy 2.11.4 或更新

IP 证书要这个版本。Ubuntu 自带的 Caddy 往往更旧，不要用那个。

2026 年 1 月 15 日 Let's Encrypt 正式发放 IP 证书和 6 天证书。IP 证书**必须**选择名为 `shortlived` 的配置，有效期是 **160 小时**（比 6 天略多）。Caddy 2.11 能填这个配置；IPv6 的相关问题在 **2.11.4** 里修好了。这台机器只用 IPv4 的话，也不要装比 2.11.4 更旧的包，免得碰到「cannot have public IP certificate」。

### Ubuntu / Debian（官方源）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```

`caddy version` 必须是 `v2.11.4` 或更高。如果源里的版本更旧，卸掉它，改用下面的二进制。

### 版本不够，或是 OpenCloudOS

到 <https://github.com/caddyserver/caddy/releases> 下 `caddy_*_linux_amd64.tar.gz`，版本号至少 2.11.4。GitHub 慢时可以用你信任的镜像，下完核对发布页上的校验和。

```bash
sudo install -m 755 caddy /usr/bin/caddy
caddy version
sudo useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy || true
sudo mkdir -p /etc/caddy /var/lib/caddy
sudo chown -R caddy:caddy /var/lib/caddy
```

官方 deb 包会自己建好用户和 systemd 服务。用二进制安装时，还需要一份 Caddy 的 systemd 单元（官方仓库 `dist/init/caddy.service`）。把 `ExecStart` 指到 `/usr/bin/caddy run --config /etc/caddy/Caddyfile`。

## 6. 临时 IP 证书

先在轻量防火墙放行 **80/TCP** 和 **8443/TCP**。不要放行 8787。

Let's Encrypt 怎么证明这台机器拥有这个 IP（2025-07-01 的说明，2026-01-15 起正式开放）：

- 可以用 **http-01**：验证服务器访问 `http://你的公网IP/` 的 80 端口。
- 可以用 **tls-alpn-01**：验证服务器访问 **443** 端口。
- **不能**用 DNS-01。IP 没有可写的 TXT 记录。

`Caddyfile.ip-temp` 关掉了 tls-alpn，只走 http-01。因此：

- 公网 **80 必须通**。不通就签不出证书。
- 公网 **443 不是这套配置的签发条件**。
- **8443 不参与签发**，只给插件用。

有些 2026 年的实践记录写过：IP 证书的 tls-alpn 不稳定，http-01 是当时能签下来的那条。所以这里把 tls-alpn 关掉，避免 Caddy 先在 443 上失败、拖很久才改走 80。

编辑配置：

```bash
sudo cp Caddyfile.ip-temp /etc/caddy/Caddyfile
sudo editor /etc/caddy/Caddyfile
```

把三处 `203.0.113.10` 换成轻量控制台里的公网 IPv4。把 `admin@example.com` 换成你的邮箱（Let's Encrypt 用来通知证书快过期；Caddy 正常续期时你通常收不到信）。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo journalctl -u caddy -n 80 --no-pager
```

日志里应出现正在获取 `203.0.113.10`（你的 IP）的证书，而不是 `cannot have public IP certificate`。第一次可能要一两分钟。证书大约 6 天过期，Caddy 开着并且 80 端口一直通，就会自己续。不要反复删 `/var/lib/caddy`，Let's Encrypt 对同一组名字每 7 天签发次数有限。

签不出来时：

- 从另一台电脑访问 `http://公网IP/`，应看到 `ok`。看不到就是防火墙或腾讯云拦了 80。
- 确认 Caddy 版本 ≥ 2.11.4。
- **ZeroSSL 不能当作退路。** 没有公开资料表明 ZeroSSL 会给裸 IP 签一张浏览器信任的证书。Caddy 默认失败后可能去试 ZeroSSL，对 IP 这步可以忽略。
- 自签证书也不行。Chrome 和 WhatsApp 网页不会信任它，`wss://` 直接失败。
- 签不出来就等备案域名，改用 `Caddyfile.domain`。不要为了 IP 证书去改 `server.js`。

## 7. 检查中转

在服务器上：

```bash
curl -fsS http://127.0.0.1:8787/health
```

在你自己的电脑上（把 IP 和密码换成你的）：

```bash
curl -fsS https://公网IP:8443/health
```

应是 `{"ok":true}`。证书不被信任时，curl 会报错；先看 `journalctl -u caddy`，不要用 `curl -k` 糊弄过去，插件也不会忽略证书错误。

再测 WebSocket。错误的密钥应被拒绝，正确的密钥应出现 `101`：

```bash
curl -i --http1.1 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://公网IP:8443/aliyun?k=错误的密码"
```

第一行应是 `HTTP/1.1 401`。把 `k=` 换成 `/etc/call-relay.env` 里的 `RELAY_KEY` 再跑一次，第一行应是 `HTTP/1.1 101 Switching Protocols`。看到 101 就可以停掉这条 curl。

另外确认公网打不进 Node：

```bash
curl -m 5 http://公网IP:8787/health
```

这行应该超时或被拒绝，而不是 `{"ok":true}`。

## 8. 插件里填什么

设置 → 通话同传：

- 中转地址：`https://公网IP:8443/session`
- 中转密钥：和服务器上 `RELAY_KEY` 完全一样

不要填百炼的长期 Key。插件会自己把地址换成 `wss://公网IP:8443/aliyun?k=...` 去传语音。点「测试连接」，它访问的是 `https://公网IP:8443/health`。

## 备案后怎么切换

域名解析到这台机器，并且备案通过之后：

1. 把 `Caddyfile.domain` 复制成 `/etc/caddy/Caddyfile`，把 `call.example.com` 换成你的域名，邮箱也改一下。
2. `sudo caddy validate --config /etc/caddy/Caddyfile`，然后 `sudo systemctl reload caddy`。
3. 轻量防火墙开放 443/TCP。80 继续开着，给域名证书的 http-01 用。不需要 8443 了就可以关掉。
4. 插件里的中转地址改成 `https://你的域名/session`。中转密钥、百炼 Key、业务空间都不用动。

Node 仍然听 8787，Caddy 仍然反代到 `127.0.0.1:8787`。`/session` 和 `/aliyun` 都还在。

## 如何彻底移除 Caddy

只卸门面、中转还留着：

```bash
sudo systemctl disable --now caddy
sudo apt remove --purge caddy
sudo rm -rf /etc/caddy /var/lib/caddy
```

OpenCloudOS 上如果 Caddy 是手动拷的二进制：`sudo rm /usr/bin/caddy`，再删 `/etc/systemd/system/caddy.service`（如果有），然后 `sudo systemctl daemon-reload`。

连中转一起拆掉：

```bash
sudo systemctl disable --now call-relay
sudo rm /etc/systemd/system/call-relay.service
sudo rm /etc/call-relay.env
sudo rm -rf /opt/call-relay
sudo userdel callrelay
sudo systemctl daemon-reload
```

然后在轻量防火墙里删掉 80、443、8443 的放行。8787 本来就不应放行。

这些步骤只动服务器。浏览器里的插件不用卸载；把「通话同传」关掉即可。仓库里的 `call-relay/deploy/` 也可以整夹删除，不影响 `server.js` 和用户脚本。
