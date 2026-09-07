"""Bounded, path-checked backup archives. Python 3.6+ standard library only."""
import hashlib
import os
import pathlib
import posixpath
import shutil
import tarfile


def checksum(path):
    digest = hashlib.sha256()
    with open(str(path), 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def within(path, root):
    path, root = pathlib.Path(path).resolve(), pathlib.Path(root).resolve()
    return path == root or root in path.parents


def pack(source, target):
    source, target = pathlib.Path(source), pathlib.Path(target)
    if not source.exists():
        raise ValueError('backup source missing')
    boundary = source.resolve() if source.is_dir() else source.parent.resolve()
    entries=[source]
    if source.is_dir():
        for folder, dirs, files in os.walk(str(source), followlinks=False):
            entries.extend(pathlib.Path(folder)/name for name in dirs+files)
    with tarfile.open(str(target), 'w:gz', dereference=False) as archive:
        for path in entries:
            if not within(path,boundary):raise ValueError('external source link')
            name='data' if path==source else 'data/'+path.relative_to(source).as_posix()
            item=archive.gettarinfo(str(path),arcname=name)
            if item.issym():
                item.linkname=os.path.relpath(str(path.resolve()),str(path.parent.resolve()))
                archive.addfile(item)
            elif item.isdir():archive.addfile(item)
            elif item.isfile() or item.islnk():
                item.type=tarfile.REGTYPE;item.linkname='';item.size=path.stat().st_size
                with open(str(path),'rb') as incoming:archive.addfile(item,incoming)
            else:raise ValueError('unsupported backup source entry')
    os.chmod(str(target), 0o600)
    return {'bytes': target.stat().st_size, 'sha256': checksum(target)}


def members(archive, max_bytes=20 * 1024 ** 3, max_files=500000):
    size, count, names = 0, 0, set()
    for item in archive:
        path = pathlib.PurePosixPath(item.name)
        if path.is_absolute() or '..' in path.parts or '\\' in item.name or not path.parts or path.parts[0] != 'data':
            raise ValueError('unsafe archive path')
        if not (item.isfile() or item.isdir() or item.issym()) or item.name in names:
            raise ValueError('unsupported or duplicate archive entry')
        if item.issym():
            target=posixpath.normpath(posixpath.join(str(path.parent),item.linkname))
            if item.linkname.startswith('/') or '\\' in item.linkname or not (target=='data' or target.startswith('data/')):raise ValueError('unsafe archive link')
        names.add(item.name)
        size += item.size
        count += 1
        if size > max_bytes or count > max_files:
            raise ValueError('archive expansion limit exceeded')
        yield item


def unpack(source, target):
    target = pathlib.Path(target)
    if target.exists():
        raise ValueError('restore destination must be new')
    # Validate every member before creating the destination.
    with tarfile.open(str(source), 'r:gz') as archive:
        checked=list(members(archive));links={m.name for m in checked if m.issym()}
        for item in checked:
            if any(str(p) in links for p in pathlib.PurePosixPath(item.name).parents):raise ValueError('archive entry under symbolic link')
    target.mkdir(parents=True, mode=0o700)
    directories=[];links=[]
    with tarfile.open(str(source), 'r:gz') as archive:
        for item in members(archive):
            destination = target / item.name
            if not within(destination, target):
                raise ValueError('restore path escaped')
            if item.isdir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                directories.append((destination,item))
            elif item.issym():links.append((destination,item))
            else:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(item) as incoming, open(str(destination), 'xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                os.chmod(str(destination), item.mode & 0o777)
                if hasattr(os, 'chown') and os.geteuid() == 0:
                    os.chown(str(destination), item.uid, item.gid)
    for destination,item in links:
        destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700);os.symlink(item.linkname,str(destination))
    for destination,item in reversed(directories):
        os.chmod(str(destination),item.mode & 0o777)
        if hasattr(os,'chown') and os.geteuid()==0:os.chown(str(destination),item.uid,item.gid)
    return target / 'data'
