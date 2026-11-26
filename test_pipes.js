const net = require('net');

console.log('Testing PipeZCallSend...');
const s1 = net.connect('\\\\.\\pipe\\PipeZCallSend', () => {
  console.log('Successfully connected to PipeZCallSend');
  s1.destroy();
}).on('error', err => {
  console.log('Error PipeZCallSend:', err.message);
});

console.log('Testing PipeZCallRecv...');
const s2 = net.connect('\\\\.\\pipe\\PipeZCallRecv', () => {
  console.log('Successfully connected to PipeZCallRecv');
  s2.destroy();
}).on('error', err => {
  console.log('Error PipeZCallRecv:', err.message);
});

console.log('Testing PipeZCallSend_ultra...');
const s3 = net.connect('\\\\.\\pipe\\PipeZCallSend_ultra', () => {
  console.log('Successfully connected to PipeZCallSend_ultra');
  s3.destroy();
}).on('error', err => {
  console.log('Error PipeZCallSend_ultra:', err.message);
});

console.log('Testing PipeZCallRecv_ultra...');
const s4 = net.connect('\\\\.\\pipe\\PipeZCallRecv_ultra', () => {
  console.log('Successfully connected to PipeZCallRecv_ultra');
  s4.destroy();
}).on('error', err => {
  console.log('Error PipeZCallRecv_ultra:', err.message);
});
