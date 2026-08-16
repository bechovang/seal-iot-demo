/* Copy file này thành config.js và điền key (config.js đã được gitignore).
   Hoặc không cần file này: bấm chip "Neuro-LLM" trên topbar để dán key
   (lưu localStorage). Không có key thì demo chạy chế độ SYMBOLIC-ONLY. */
window.__OPENROUTER_KEY__ = '';
window.__OPENROUTER_MODEL__ = 'deepseek/deepseek-v4-flash-0731';

/* REALTIME mode — broker BTC (Track C). Host PHẢI là mqtt-hackathon (đủ "thon").
   Điền giá trị thật (BTC phát) — file config.js thật không được commit. */
window.__MQTT_REAL__ = {
  host: 'mqtt-hackathon.lexatek.vn',
  port: 443,
  path: '/mqtt',
  username: '<USERNAME>',
  password: '<PASSWORD>',
  teamCode: 'UNDERRATED',
  subTopic: 'hackathon/underrated/test/telemetry',
  pubTopic: 'hackathon/underrated/judge/telemetry',
  testKey: '<TEST_KEY>', // cổng TEST của BTC (không dùng cho MQTT connect)
};
