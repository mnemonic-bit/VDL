const details = document.getElementById('details');
const status = document.getElementById('status');

function row(name, value) {
    const term = document.createElement('dt'); term.textContent = name;
    const description = document.createElement('dd'); description.textContent = value || 'Never';
    details.append(term, description);
}

async function render() {
    details.replaceChildren();
    const [paired, state] = await Promise.all([
        browser.runtime.sendMessage({type: 'status'}),
        browser.storage.local.get('lastError'),
    ]);
    if (state.lastError) {
        status.textContent = `${state.lastError.message} ${state.lastError.guidance}`;
    }
    if (!paired) {
        row('Status', 'Not paired');
        document.getElementById('test').disabled = true;
        document.getElementById('unpair').disabled = true;
        return;
    }
    row('VDL origin', paired.origin);
    row('Username', paired.username);
    row('Device label', paired.deviceLabel);
    row('Extension version', paired.extensionVersion);
    row('Last successful contact', paired.lastSuccessfulContact ? new Date(paired.lastSuccessfulContact).toLocaleString() : null);
    if (paired.unusable) row('Status', 'Re-pair required');
}

document.getElementById('test').addEventListener('click', async () => {
    try { await browser.runtime.sendMessage({type: 'test'}); status.textContent = 'Connection is working.'; }
    catch (error) { status.textContent = error.message; }
    await render();
});
document.getElementById('unpair').addEventListener('click', async () => {
    try { await browser.runtime.sendMessage({type: 'unpair'}); status.textContent = 'Unpaired.'; }
    catch (error) { status.textContent = `Unpaired locally. ${error.message}`; }
    await render();
});
render();
