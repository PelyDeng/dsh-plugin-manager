#!/usr/bin/env python3
"""Install the fixed systemd services from an explicit root-owned configuration."""
import argparse
import os
import pathlib
import subprocess
import sys
from executor import Executor, load_config


def quoted(value):
    if '\n' in value or '\r' in value:raise ValueError('invalid service path')
    return '"'+value.replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    if os.geteuid()!=0:raise SystemExit('root is required to install the scoped backup executor')
    config=load_config(args.config);path=pathlib.Path(config['_path'])
    if path.stat().st_uid!=0 or path.stat().st_mode & 0o077:raise SystemExit('executor configuration must be root-owned mode 600')
    command=' '.join(quoted(str(p)) for p in [pathlib.Path(sys.executable).resolve(),pathlib.Path(__file__).resolve().parent/'executor.py'])+' --config '+quoted(str(path))
    folder=pathlib.Path('/etc/systemd/system')
    for name,action,kind in [('api','serve','simple'),('run','run','oneshot'),('restore','restore','oneshot')]:
        service='[Unit]\nDescription=DSH blog '+name+'\nAfter=network.target docker.service\n[Service]\nType='+kind+'\nUMask=0077\nExecStart='+command+' '+action+'\n'
        if name=='api':service+='Restart=on-failure\nRestartSec=5\n'
        else:service+='TimeoutStartSec=1800\nExecStopPost='+command+' recover\n'
        service+='\n[Install]\nWantedBy=multi-user.target\n'
        (folder/('dsh-blog-backup-'+name+'.service')).write_text(service,encoding='utf-8')
    (folder/'dsh-blog-backup.timer').write_text('[Unit]\nDescription=Daily DSH blog backup\n[Timer]\nOnCalendar=*-*-* 03:00:00 Asia/Shanghai\nPersistent=true\nUnit=dsh-blog-backup-run.service\n[Install]\nWantedBy=timers.target\n',encoding='utf-8')
    subprocess.check_call(['systemctl','daemon-reload'])
    subprocess.check_call(['systemctl','enable','--now','dsh-blog-backup-api.service'])
    subprocess.check_call(['systemctl','restart','dsh-blog-backup-api.service'])
    executor=Executor(config);executor.set_schedule(executor.schedule())
    print('Scoped backup API and daily timer installed.')


if __name__=='__main__':main()
