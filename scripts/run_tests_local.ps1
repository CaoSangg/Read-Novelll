# Load only the local test URL in a child process; never change persistent environment.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    $runner = @'
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from dotenv import dotenv_values
from psycopg.conninfo import conninfo_to_dict

try:
    url = dotenv_values('.env.local.txt').get('DATABASE_URL')
    info = conninfo_to_dict(url) if url else {}
    if info.get('dbname') != 'readnovel_test' or info.get('host') not in ('localhost', '127.0.0.1', '::1'):
        raise ValueError()
except Exception:
    print('Refused: .env.local.txt must provide DATABASE_URL for local readnovel_test.', file=sys.stderr)
    sys.exit(2)
env = os.environ.copy()
env['DATABASE_URL'] = url
env['TEST_DATABASE_URL'] = url
temp = tempfile.mkdtemp(prefix='readnovel-tests-')
sys.exit(subprocess.call([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--basetemp', temp], env=env))
'@
    & .\.venv\Scripts\python.exe -c $runner
    $testExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $testExitCode
