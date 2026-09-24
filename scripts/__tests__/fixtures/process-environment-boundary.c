#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Read only the caller-created synthetic process. Never emit returned bytes. */
int main(int argc, char **argv) {
  if (argc != 3 || argv[2][0] == '\0') return 2;
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (*end != '\0' || parsed < 2 || parsed > INT_MAX) return 2;
  int mib[] = {CTL_KERN, KERN_PROCARGS2, (int)parsed};
  size_t size = 1024 * 1024;
  char *buffer = malloc(size);
  if (!buffer) return 2;
  int rc = sysctl(mib, 3, buffer, &size, NULL, 0);
  int error = rc == 0 ? 0 : errno;
  size_t marker_size = strlen(argv[2]);
  int found = 0;
  if (rc == 0) {
    for (size_t i = 0; i + marker_size <= size; i++) {
      if (memcmp(buffer + i, argv[2], marker_size) == 0) found = 1;
    }
  }
  free(buffer);
  printf("{\"status\":%d,\"errno\":%d,\"found\":%s}\n", rc, error,
         found ? "true" : "false");
  return 0;
}
