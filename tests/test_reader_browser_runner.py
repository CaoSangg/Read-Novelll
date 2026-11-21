"""Browser runner failures remain distinguishable when workers or cleanup stop early."""

from subprocess import TimeoutExpired
from unittest.mock import MagicMock, Mock
from uuid import uuid4

import pytest

from scripts import check_reader_resume_browser as runner


def test_offline_receipt_server_refuses_nonlocal_dsn_before_connect(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://127.0.0.1/readnovel_471a_test_123456abcdef_migrated?hostaddr=192.0.2.1",
    )
    connect = Mock()
    monkeypatch.setattr(runner.psycopg, "connect", connect)
    with pytest.raises(ValueError, match="disposable loopback database"):
        runner.serve_offline_fixture(4444, str(uuid4()))
    connect.assert_not_called()


def test_app_readiness_retries_until_health_returns_200(monkeypatch):
    server = Mock()
    server.poll.return_value = None
    starting, ready = Mock(), Mock()
    starting.getresponse.return_value.status = 503
    ready.getresponse.return_value.status = 200
    connect = Mock(side_effect=[starting, ready])
    monkeypatch.setattr(runner, "HTTPConnection", connect)
    monkeypatch.setattr(runner.time, "sleep", Mock())

    assert runner.wait_for_app(server, 4321) is None
    assert connect.call_count == 2
    starting.request.assert_called_once_with("GET", "/api/health/readiness")
    starting.close.assert_called_once()
    ready.close.assert_called_once()


def simulate(monkeypatch, *, node_code, edge_code, trace, profile_result=(None, 0), forced=False):
    node = Mock()
    node.pid = 101
    node.returncode = node_code
    node.communicate.return_value = (trace, None)
    node_process = MagicMock()
    node_process.return_value.__enter__.return_value = node
    edge = Mock()
    edge.pid = 102
    edge.poll.return_value = edge_code
    if forced:
        edge.poll.side_effect = [None, edge_code]
        edge.wait.side_effect = TimeoutExpired("edge", 3)
        monkeypatch.setattr(runner, "kill_owned_process", Mock())

    def release(profile):
        profile.cleanup()
        return profile_result

    monkeypatch.setattr(runner, "start_owned_edge", lambda *_: edge)
    monkeypatch.setattr(runner.subprocess, "Popen", node_process)
    monkeypatch.setattr(runner, "release_browser_profile", release)
    return runner.run_edge_qa({"suite": "completion", "history": "auto", "round": 3})


def test_native_node_exit_retains_exact_bits_even_with_profile_lock(monkeypatch):
    monkeypatch.setattr(runner.sys, "platform", "win32")
    monkeypatch.setattr(runner, "windows_memory_sample", lambda: "physical load=85%")
    native = 0xC0000409
    code, trace = simulate(
        monkeypatch,
        node_code=native,
        edge_code=0,
        trace="Browser QA [completion/auto round=3] Node ready\n",
        profile_result=(None, 1),
    )
    assert code == native
    assert runner.shell_exit(code) == -1073740791
    assert trace[0].endswith("Node ready")
    assert any("released Edge profile after 1 retries" in line for line in trace)
    assert any("Node native termination: 3221226505 (0xC0000409)" in line for line in trace)
    assert any("Edge=0 (0x00000000)" in line for line in trace)
    assert any(
        "before cleanup Node PID=101, Edge PID=102, Edge=0 (0x00000000), physical load=85%" in line
        for line in trace
    )


def test_edge_exit_and_cdp_failure_keep_separate_diagnostics(monkeypatch):
    code, trace = simulate(
        monkeypatch, node_code=1, edge_code=7, trace="FAIL Browser QA CDP target disconnected\n"
    )
    assert code == 1
    assert trace[0].endswith("CDP target disconnected")
    assert any("Edge process exit: 7" in line for line in trace)
    assert not any("Node native termination" in line for line in trace)


def test_cleanup_failure_retains_assertion_and_child_exit_codes(monkeypatch):
    code, trace = simulate(
        monkeypatch,
        node_code=1,
        edge_code=0,
        trace="FAIL Browser QA assertion Control not clickable: #auth-submit\n",
        profile_result=("PermissionError (winerror=32)", 4),
    )
    assert code == 1
    assert trace[0].endswith("Control not clickable: #auth-submit")
    assert any("Edge profile cleanup: PermissionError" in line for line in trace)
    assert any("Node=1" in line and "Edge=0" in line for line in trace)


def test_cleanup_only_failure_does_not_misreport_node_failure(monkeypatch):
    code, trace = simulate(
        monkeypatch,
        node_code=0,
        edge_code=0,
        trace="PASS browser assertions\n",
        profile_result=("PermissionError (winerror=32)", 4),
    )
    assert code == 1
    assert trace[0] == "PASS browser assertions"
    assert any("Edge profile cleanup" in line for line in trace)
    assert any("Node=0" in line and "Edge=0" in line for line in trace)


def test_browser_close_sent_but_owned_edge_requires_forced_stop(monkeypatch):
    code, trace = simulate(
        monkeypatch,
        node_code=0,
        edge_code=1,
        forced=True,
        trace="PASS browser assertions\nBrowser.close sent\n",
    )
    assert code == 1
    assert trace[:2] == ["PASS browser assertions", "Browser.close sent"]
    assert any("Edge required a forced stop" in line for line in trace)
    assert any(
        "Node=0" in line and "Edge=1" in line and "forced Edge stop=True" in line for line in trace
    )
    runner.kill_owned_process.assert_called_once()
