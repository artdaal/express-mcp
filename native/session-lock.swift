import Foundation
import Darwin

guard CommandLine.arguments.count == 2 else { exit(2) }
let fd = open(CommandLine.arguments[1], O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard fd >= 0 else { exit(2) }
var info = stat()
guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o077) == 0 else { close(fd); exit(2) }
guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); exit(3) }
FileHandle.standardOutput.write(Data("{\"ok\":true}\n".utf8))
// A private pipe ties the advisory lock to the daemon lifetime, including crashes.
while !FileHandle.standardInput.readData(ofLength: 1).isEmpty {}
flock(fd, LOCK_UN)
close(fd)
