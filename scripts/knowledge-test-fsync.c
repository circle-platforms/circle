// Optional macOS companion to knowledge-test-metrics.mjs; never linked into Circle.
// Build with clang -dynamiclib, then set DYLD_INSERT_LIBRARIES for the measured
// test command. Node/libuv's fsyncSync is counted by the JS preload separately.
// The calibration is one Node fsyncSync => 1 JS / 0 native, and two SQLite FULL
// rollback-journal writes => 0 JS / 8 native on the measured Node 24 build.
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdatomic.h>
#include <errno.h>

static _Atomic unsigned long calls;
static int record = -1;
static pid_t parent;
static char program[64];

static void snapshot(void) {
  if (record < 0) return;
  char bytes[256];
  int n = snprintf(bytes, sizeof(bytes),
      "{\"pid\":%d,\"parentPid\":%d,\"program\":\"%s\",\"nativeFsyncCalls\":%lu}\n",
      getpid(), parent, program, atomic_load(&calls));
  pwrite(record, bytes, n, 0);
  ftruncate(record, n);
}

__attribute__((constructor)) static void start(void) {
  const char *directory = getenv("CIRCLE_KNOWLEDGE_TEST_METRICS");
  if (!directory) return;
  parent = getppid();
  const char *name = getprogname();
  if (!name) name = "unknown";
  size_t i;
  for (i = 0; name[i] && i < sizeof(program) - 1; i++) {
    char c = name[i];
    program[i] = ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_') ? c : '_';
  }
  program[i] = 0;
  char path[2048];
  int n = snprintf(path, sizeof(path), "%s/%d.native.json", directory, getpid());
  if (n < 0 || (size_t)n >= sizeof(path)) return;
  record = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  snapshot();
}

static int counted_fsync(int fd) {
  atomic_fetch_add(&calls, 1);
  int result = fsync(fd);
  int saved_errno = errno;
  snapshot();
  errno = saved_errno;
  return result;
}

__attribute__((used)) static const struct {
  const void *replacement;
  const void *original;
} interpose __attribute__((section("__DATA,__interpose"))) = {
    (const void *)&counted_fsync, (const void *)&fsync
};

__attribute__((destructor)) static void stop(void) {
  snapshot();
  if (record >= 0) close(record);
}
