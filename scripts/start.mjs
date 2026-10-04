// Bind exclusively to loopback; this prototype is a single-user local server.
process.env.HOST = '127.0.0.1';
process.env.PORT ||= '5173';
process.env.APP_ORIGIN ||= `http://127.0.0.1:${process.env.PORT}`;
process.env.ORIGIN = process.env.APP_ORIGIN;
process.env.BODY_SIZE_LIMIT = '12M';
await import('../build/index.js');
