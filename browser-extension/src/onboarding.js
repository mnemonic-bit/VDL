function isLocalHttpHostname(value) {
    const hostname = value.toLowerCase().replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
            hostname === '[::1]' || hostname === '::1') {
        return true;
    }
    const octets = hostname.split('.');
    if (octets.length !== 4 || !octets.every(
        octet => /^\d+$/.test(octet) && Number(octet) <= 255
    )) return false;
    const first = Number(octets[0]);
    const second = Number(octets[1]);
    return first === 127 || first === 10 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
}

function isAllowedVdlTransport(url) {
    return url.protocol === 'https:' ||
        (url.protocol === 'http:' && isLocalHttpHostname(url.hostname));
}

function permissionPattern(url) {
    return `${url.protocol}//${url.hostname}/*`;
}

function decodePairingString(value) {
    if (!value.startsWith('vdl-pair-v1:')) throw new Error('Invalid pairing string.');
    const encoded = value.slice('vdl-pair-v1:'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid pairing string.');
    let decoded;
    try {
        const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
        const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
        decoded = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    } catch (_) { throw new Error('Invalid pairing string.'); }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) ||
            Object.keys(decoded).sort().join(',') !== 'code,origin' ||
            !/^VDL1-[A-Za-z0-9_-]{22}$/.test(decoded.code)) {
        throw new Error('Invalid pairing string.');
    }
    const url = new URL(decoded.origin);
    if (!isAllowedVdlTransport(url) || url.username || url.password ||
            !url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
        throw new Error('Pairing requires trusted HTTPS or operator-enabled local IPv4 HTTP.');
    }
    if (url.origin !== decoded.origin) throw new Error('The VDL origin is not normalized.');
    return {origin: url.origin, code: decoded.code};
}

const form = document.getElementById('pairForm');
const pairing = document.getElementById('pairingString');
const preview = document.getElementById('originPreview');
const status = document.getElementById('status');

function destinationLabel(data, confirmation = false) {
    const prefix = confirmation ? 'Confirm VDL destination' : 'VDL destination';
    const warning = data.origin.startsWith('http:')
        ? ' — private HTTP is not encrypted' : '';
    return `${prefix}: ${data.origin}${warning}`;
}

pairing.addEventListener('input', () => {
    try {
        const data = decodePairingString(pairing.value.trim());
        preview.textContent = destinationLabel(data);
        preview.hidden = false;
        status.textContent = '';
    } catch (_) { preview.hidden = true; }
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        const data = decodePairingString(pairing.value.trim());
        preview.textContent = destinationLabel(data, true);
        preview.hidden = false;
        if (!await browser.permissions.request({
            origins: [permissionPattern(new URL(data.origin))],
        })) {
            throw new Error('Firefox access to this VDL was not granted.');
        }
        const result = await browser.runtime.sendMessage({
            type: 'pair', ...data, deviceLabel: document.getElementById('deviceLabel').value,
        });
        pairing.value = '';
        status.textContent = `Paired with ${result.origin} as ${result.username}.`;
    } catch (error) { status.textContent = error.message; }
});
