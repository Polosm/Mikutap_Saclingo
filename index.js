const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const ENGINE_PORT = 30002;

const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';
const WS_PATH = process.env.WS_PATH || '/vcc';

// ================= 安全气囊：防止意外错误导致容器崩溃 =================
process.on('uncaughtException', (err) => {
    // 拦截 EPIPE 和 ECONNRESET，只打印警告，不中断程序
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
        console.warn(`[Proxy Warning] Connection drop intercepted: ${err.code}`);
    } else {
        console.error(`[Fatal Error] Uncaught Exception:`, err);
    }
});

// 1. 动态生成引擎配置文件
const config = {
  log: { access: "none", error: "none", loglevel: "warning" },
  inbounds: [{
      port: ENGINE_PORT,
      listen: "127.0.0.1",
      protocol: "vless",
      settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" },
      streamSettings: { network: "ws", security: "none", wsSettings: { path: WS_PATH } }
  }],
  outbounds: [{ protocol: "freedom" }]
};
fs.writeFileSync('config.json', JSON.stringify(config));

// 2. 赋予核心进程执行权限并拉起
try {
    fs.chmodSync('./miku_engine', 0o755);
    console.log('[System] Permissions set for engine.');
} catch (e) {
    console.error('[System] chmod failed, file might already be executable.');
}

const engine = spawn('./miku_engine', ['-config', 'config.json']);
engine.stdout.on('data', (data) => console.log(`[Engine]: ${data.toString().trim()}`));
engine.stderr.on('data', (data) => console.error(`[Engine Error]: ${data.toString().trim()}`));
engine.on('close', (code) => console.log(`[Engine] Exited with code ${code}`));

// 3. 托管 Mikutap 前端静态资源
const mikutapDirs = ['css', 'data', 'js', 'shared'];
mikutapDirs.forEach(dir => {
  app.use(`/${dir}`, express.static(path.join(__dirname, dir)));
});
app.get('/icon.png', (req, res) => res.sendFile(path.join(__dirname, 'icon.png')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 增加一个简单的健康检查路由 (应付云平台的探测)
app.get('/health', (req, res) => res.status(200).send('OK'));

// 4. WebSocket 流量反向代理
server.on('upgrade', (req, socket, head) => {
    if (req.url === WS_PATH) {
        const proxy = http.request({
            port: ENGINE_PORT,
            host: '127.0.0.1',
            method: req.method,
            headers: req.headers,
            path: req.url
        });

        proxy.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            let response = `HTTP/${req.httpVersion} 101 Switching Protocols\r\n`;
            for (let key in proxyRes.headers) {
                response += `${key}: ${proxyRes.headers[key]}\r\n`;
            }
            response += '\r\n';
            socket.write(response);
            proxySocket.pipe(socket).pipe(proxySocket);
        });

        // 增强错误捕获：防止内部代理请求错误抛出到外层
        proxy.on('error', (err) => {
            console.error(`[Proxy] Engine not ready or connection reset: ${err.message}`);
            socket.destroy(); // 安全销毁当前连接，防止泄漏
        });

        proxy.end();
    } else {
        socket.destroy();
    }
});

// 增加一个微小的延时启动 Web 服务，确保引擎有充足时间绑定本地端口
setTimeout(() => {
    server.listen(PORT, () => {
         console.log(`[System] Interactive web application is running on port ${PORT}`);
    });
}, 1000); // 延迟 1 秒启动 HTTP 监听
