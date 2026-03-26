const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Scalingo 动态分配的端口
const PORT = process.env.PORT || 3000;
// 引擎内部监听端口 (不暴露到公网)
const ENGINE_PORT = 30002;

// 环境变量配置 (可以在 Scalingo 控制台修改)
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';
const WS_PATH = process.env.WS_PATH || '/vcc';

// 1. 动态生成隐蔽的引擎配置文件
const config = {
  log: { access: "none", error: "none", loglevel: "none" },
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

// 2. 赋予核心进程执行权限并静默启动
try {
    fs.chmodSync('./miku_engine', 0o755);
} catch (e) {
    // 忽略权限修改错误，防崩溃
}
const engine = spawn('./miku_engine', ['-config', 'config.json']);
engine.on('error', () => {}); // 屏蔽错误日志

// 3. 托管 Mikutap 前端静态资源
const mikutapDirs = ['css', 'data', 'js', 'shared'];
mikutapDirs.forEach(dir => {
  app.use(`/${dir}`, express.static(path.join(__dirname, dir)));
});
app.get('/icon.png', (req, res) => res.sendFile(path.join(__dirname, 'icon.png')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 4. WebSocket 流量反向代理 (纯净转发，无特征)
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
            socket.write(
                `HTTP/${req.httpVersion} 101 Switching Protocols\r\n` +
                Object.keys(proxyRes.headers).map(k => `${k}: ${proxyRes.headers[k]}`).join('\r\n') +
                '\r\n\r\n'
            );
            proxySocket.pipe(socket).pipe(proxySocket);
        });
        proxy.on('error', () => { socket.end(); });
        req.pipe(proxy);
    } else {
        socket.destroy();
    }
});

server.listen(PORT, () => {
     console.log('Interactive web application is successfully running.');
});
