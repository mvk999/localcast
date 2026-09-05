import os from 'node:os';
import { execFileSync } from 'node:child_process';

const EXCLUDED_INTERFACE = /^(?:lo|docker\d*|br-|veth|virbr|vmnet|vboxnet|tailscale|wg\d*|tun\d*|tap\d*|zt)/i;

export function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function defaultRouteInterface() {
  try {
    // This asks the kernel to resolve its route table; it does not contact 1.1.1.1.
    const route = execFileSync('ip', ['route', 'get', '1.1.1.1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return route.match(/\bdev\s+(\S+)/)?.[1];
  } catch {
    return undefined;
  }
}

export function availableLanInterfaces(networkInterfaces = os.networkInterfaces()) {
  return Object.entries(networkInterfaces)
    .filter(([name]) => !EXCLUDED_INTERFACE.test(name))
    .flatMap(([name, entries]) => (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
      .map((entry) => ({ name, address: entry.address, netmask: entry.netmask })));
}

export function selectLanInterface({ host, networkInterfaces = os.networkInterfaces(), routeInterface = defaultRouteInterface() } = {}) {
  const candidates = availableLanInterfaces(networkInterfaces);
  if (host) {
    const selected = candidates.find((candidate) => candidate.address === host);
    if (!selected) throw new Error(`--host must be an active private IPv4 LAN address (received ${host}).`);
    return selected;
  }

  const routed = candidates.find((candidate) => candidate.name === routeInterface);
  if (routed) return routed;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new Error('No suitable private IPv4 LAN interface found. Use --host <private-ip> after connecting to your LAN.');
  throw new Error(`More than one private LAN interface is available. Start with --host <address>: ${candidates.map((item) => item.address).join(', ')}.`);
}

export function isAddressOnSubnet(address, network) {
  const toInt = (value) => value.split('.').reduce((total, octet) => ((total << 8) | Number(octet)) >>> 0, 0);
  if (!isPrivateIPv4(address)) return false;
  const mask = toInt(network.netmask);
  return (toInt(address) & mask) === (toInt(network.address) & mask);
}
