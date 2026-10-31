import assert from 'node:assert/strict';
import test from 'node:test';
import * as history from '../src/claude-session-history.mjs';
import * as active from '../src/active-agent-sessions.mjs';
import * as overview from '../src/agent-workspace-overview.mjs';
import * as sharedHistory from '../../../skills/session-mgr/scripts/discovery/claude-session-history.mjs';
import * as sharedActive from '../../../skills/session-mgr/scripts/discovery/active-agent-sessions.mjs';
import * as sharedOverview from '../../../skills/session-mgr/scripts/discovery/agent-workspace-overview.mjs';
import * as list from '../src/session-list.mjs';
import * as sharedList from '../../../skills/session-mgr/scripts/session-list.mjs';

test('Gateway compatibility entries delegate all three queries to SessionMgr', () => {
  assert.equal(history.collectClaudeHistory, sharedHistory.collectClaudeHistory);
  assert.equal(active.collectActiveAgentSessionRecords, sharedActive.collectActiveAgentSessionRecords);
  assert.equal(overview.createAgentWorkspaceOverview, sharedOverview.createAgentWorkspaceOverview);
  assert.equal(list.collectSessionList, sharedList.collectSessionList);
  assert.equal(list.formatSessionListPages, sharedList.formatSessionListPages);
});
