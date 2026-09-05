import test from 'node:test';
import assert from 'node:assert/strict';
import { availableLanInterfaces, isAddressOnSubnet, isPrivateIPv4, selectLanInterface } from '../src/server/network.js';

const interfaces = {
  wlp1s0: [{ family: 'IPv4', internal: false, address: '192.168.1.20', netmask: '255.255.255.0' }],
  docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1', netmask: '255.255.0.0' }],
  tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.1', netmask: '255.192.0.0' }]
};

test('keeps only allowed private IPv4 interfaces', () => {
  assert.deepEqual(availableLanInterfaces(interfaces), [{ name: 'wlp1s0', address: '192.168.1.20', netmask: '255.255.255.0' }]);
  assert.equal(isPrivateIPv4('192.168.1.20'), true);
  assert.equal(isPrivateIPv4('100.64.0.1'), false);
});

test('prefers the kernel default route when safe', () => {
  assert.equal(selectLanInterface({ networkInterfaces: interfaces, routeInterface: 'wlp1s0' }).address, '192.168.1.20');
  assert.equal(isAddressOnSubnet('192.168.1.77', { address: '192.168.1.20', netmask: '255.255.255.0' }), true);
  assert.equal(isAddressOnSubnet('192.168.2.77', { address: '192.168.1.20', netmask: '255.255.255.0' }), false);
});
