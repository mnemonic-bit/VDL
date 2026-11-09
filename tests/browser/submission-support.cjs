// Correlated protocol fixtures keep ordinary form tests separate from malformed
// acknowledgement coverage in download-submissions-feedback.spec.cjs.
function downloadAcceptance(payload, id = 'accepted-download') {
    return {
        id,
        submission_revision: '1',
        current_attempt_id: `${id}-attempt`,
        job: { id: `${id}-job`, download_id: id, attempt_id: `${id}-attempt`, status: 'dispatched' },
        mutation: { id: payload.client_mutation_id, domain: 'download-submission', revision: '1', outcome: 'accepted' },
        server_time: Date.now(),
    };
}

function downloadRejection(payload, error = 'The selected options are invalid') {
    return {
        id: null, job: null, submission_revision: '0', current_attempt_id: null,
        mutation: { id: payload.client_mutation_id, domain: 'download-submission', revision: '0', outcome: 'rejected' },
        error, server_time: Date.now(),
    };
}

module.exports = { downloadAcceptance, downloadRejection };
