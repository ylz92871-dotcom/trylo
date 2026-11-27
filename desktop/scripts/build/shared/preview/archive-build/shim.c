#include <archive.h>
#include <archive_entry.h>
#include <stdlib.h>
#include <locale.h>
/* Every module is private to one worker. Keep UTF-8 filenames available
   without changing any application/operating-system locale. */
int trylo_locale_init(void) { return setlocale(LC_CTYPE, "C.UTF-8") != NULL; }
/* bzip2's BZ_NO_STDIO contract: terminate this isolated WASM job on an
   internal invariant failure, without filesystem or process handling. */
void bz_internal_error(int code) { (void)code; abort(); }
double trylo_entry_size(struct archive_entry *entry) {
    return archive_entry_size_is_set(entry) ? (double)archive_entry_size(entry) : -1;
}
int trylo_entry_regular(struct archive_entry *entry) {
    return archive_entry_filetype(entry) == AE_IFREG && !archive_entry_symlink(entry) && !archive_entry_hardlink(entry);
}
