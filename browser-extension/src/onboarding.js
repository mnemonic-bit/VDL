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
    if (url.protocol !== 'https:' || url.username || url.password ||
            !url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
        throw new Error('Pairing requires a trusted HTTPS VDL origin.');
    }
    if (url.origin !== decoded.origin) throw new Error('The VDL origin is not normalized.');
    return {origin: url.origin, code: decoded.code};
}

const form = document.getElementById('pairForm');
const pairing = document.getElementById('pairingString');
const preview = document.getElementById('originPreview');
const status = document.getElementById('status');

pairing.addEventListener('input', () => {
    try {
        const data = decodePairingString(pairing.value.trim());
        preview.textContent = `VDL destination: ${data.origin}`;
        preview.hidden = false;
        status.textContent = '';
    } catch (_) { preview.hidden = true; }
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        const data = decodePairingString(pairing.value.trim());
        preview.textContent = `Confirm VDL destination: ${data.origin}`;
        preview.hidden = false;
        const result = await browser.runtime.sendMessage({
            type: 'pair', ...data, deviceLabel: document.getElementById('deviceLabel').value,
        });
        pairing.value = '';
        status.textContent = `Paired with ${result.origin} as ${result.username}.`;
    } catch (error) { status.textContent = error.message; }
});
