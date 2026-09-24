#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

/* Synthetic item only. Never enumerate or query existing account credentials. */
int main(int argc, char **argv) {
  if (argc != 4 || strncmp(argv[2], "buildproven-sandbox-canary-",
      sizeof("buildproven-sandbox-canary-") - 1) != 0)
    return 2;
  CFStringRef service = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFDictionarySetValue(query, kSecAttrAccount, CFSTR("synthetic-boundary-test"));
  CFDictionarySetValue(query, kSecUseDataProtectionKeychain,
      strcmp(argv[3], "data-protection") == 0 ? kCFBooleanTrue : kCFBooleanFalse);
  OSStatus status;
  CFTypeRef result = NULL;
  if (strcmp(argv[1], "create") == 0) {
    const UInt8 canary[] = "non-secret-synthetic-canary";
    CFDataRef data = CFDataCreate(NULL, canary, sizeof(canary) - 1);
    CFDictionarySetValue(query, kSecValueData, data);
    status = SecItemAdd(query, NULL);
    CFRelease(data);
  } else if (strcmp(argv[1], "read") == 0) {
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    status = SecItemCopyMatching(query, &result);
  } else if (strcmp(argv[1], "delete") == 0) {
    status = SecItemDelete(query);
  } else {
    CFRelease(query);
    CFRelease(service);
    return 2;
  }
  printf("{\"status\":%d,\"returnedData\":%s}\n", (int)status,
      result != NULL ? "true" : "false");
  if (result != NULL) CFRelease(result);
  CFRelease(query);
  CFRelease(service);
  return status == errSecSuccess ? 0 : 1;
}
