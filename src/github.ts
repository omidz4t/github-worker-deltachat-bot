export async function validSignature(body: Uint8Array, signature: string | null, secret: string): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, hex => Number.parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new Uint8Array(body));
}

export function githubMessage(event: string, payload: Record<string, any>): string {
  const repo = payload.repository?.full_name ?? 'themadorg/madmail';
  const actor = payload.sender?.login ?? 'GitHub';
  const action = payload.action ? ` ${payload.action}` : '';
  let detail = '';
  let url = payload.repository?.html_url ?? `https://github.com/${repo}`;
  switch (event) {
    case 'push': {
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      detail = `${actor} pushed ${commits.length} commit(s) to ${String(payload.ref ?? '').replace('refs/heads/', '')}\n` + commits.slice(0, 8).map((c: any) => `${String(c.id).slice(0, 7)} ${String(c.message).split('\n')[0]}`).join('\n');
      url = payload.compare ?? url; break;
    }
    case 'issues': case 'issue_comment':
      detail = `${actor}${action}: issue #${payload.issue?.number} ${payload.issue?.title ?? ''}`;
      url = payload.comment?.html_url ?? payload.issue?.html_url ?? url; break;
    case 'pull_request': case 'pull_request_review': case 'pull_request_review_comment':
      detail = `${actor}${action}: PR #${payload.pull_request?.number} ${payload.pull_request?.title ?? ''}`;
      url = payload.review?.html_url ?? payload.comment?.html_url ?? payload.pull_request?.html_url ?? url; break;
    case 'release':
      detail = `${actor}${action}: release ${payload.release?.name || payload.release?.tag_name || ''}`;
      url = payload.release?.html_url ?? url; break;
    case 'workflow_run':
      detail = `${payload.workflow_run?.name ?? 'Workflow'}: ${payload.workflow_run?.conclusion ?? payload.workflow_run?.status ?? payload.action}`;
      url = payload.workflow_run?.html_url ?? url; break;
    case 'star': detail = `${actor}${action} a star`; break;
    case 'fork': detail = `${actor} forked the repository`; url = payload.forkee?.html_url ?? url; break;
    default: detail = `${actor}: ${event}${action}`;
  }
  return `[${repo}] ${event}${action}\n${detail}\n${url}`.slice(0, 4000);
}
