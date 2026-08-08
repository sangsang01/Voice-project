cmake_minimum_required(VERSION 3.19)
project(whisper_bridge CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../../vendor/whisper.cpp whisper_build)

add_executable(whisper-bridge bridge.cpp)
target_link_libraries(whisper-bridge PRIVATE whisper)

target_compile_options(whisper-bridge PRIVATE -O3 -msimd128 -pthread)

set_target_properties(whisper-bridge PROPERTIES
    LINK_FLAGS "-O3 -pthread -lembind \
        -sMODULARIZE=1 \
        -sEXPORT_NAME=createWhisperBridge \
        -sEXPORT_ES6=1 \
        -sENVIRONMENT=web,worker \
        -sALLOW_MEMORY_GROWTH=1 \
        -sINITIAL_MEMORY=256MB \
        -sMAXIMUM_MEMORY=2GB \
        -sPTHREAD_POOL_SIZE=4 \
        -sEXPORTED_RUNTIME_METHODS=['FS','HEAPU8','HEAPF32'] \
        -sEXPORTED_FUNCTIONS=['_malloc','_free'] \
        -sWASM_BIGINT=0 \
        -sSINGLE_FILE=0")
