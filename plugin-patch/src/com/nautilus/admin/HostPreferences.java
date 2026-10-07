package com.nautilus.admin;
import java.nio.file.*;
import java.io.*;
import java.util.*;
/** UUID-scoped preferences; atomic replace keeps the last usable file on failures. */
public final class HostPreferences {
 private final Path file;
 private final Properties values=new Properties();
 public HostPreferences(Path file) {
  this.file=file;if(Files.exists(file))try(var in=Files.newInputStream(file)){values.load(in);}catch(IOException ex){throw new UncheckedIOException(ex);}
 }
 public synchronized String get(UUID id,String key,String fallback){return values.getProperty(id+"."+key,fallback);}
 public synchronized void put(UUID id,Map<String,String> preferences) {
  Properties next=new Properties();next.putAll(values);for(var e:preferences.entrySet())next.setProperty(id+"."+e.getKey(),e.getValue());
  try{Files.createDirectories(file.getParent());Path tmp=Files.createTempFile(file.getParent(),"host-settings-",".tmp");
   try{try(var out=Files.newOutputStream(tmp)){next.store(out,"NautilusUHC host preferences");}
    try{Files.move(tmp,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
    catch(AtomicMoveNotSupportedException ex){Files.move(tmp,file,StandardCopyOption.REPLACE_EXISTING);}values.clear();values.putAll(next);
   }finally{Files.deleteIfExists(tmp);}
  }catch(IOException ex){throw new UncheckedIOException(ex);}
 }
}
