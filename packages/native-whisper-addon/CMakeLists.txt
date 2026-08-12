cmake_minimum_required(VERSION 3.15)
project(native_whisper_addon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Ordinary CI never runs this file; build:native is an explicit opt-in.
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)

add_subdirectory(
  "${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/whisper.cpp"
  "${CMAKE_CURRENT_BINARY_DIR}/whisper.cpp"
)

# cmake-js injects these when invoked via `npm run build:native`.
add_definitions(-DNAPI_VERSION=8)
include_directories(${CMAKE_JS_INC})

set(TARGET native-whisper-addon)

add_library(${TARGET} SHARED ${CMAKE_JS_SRC} native/addon.cpp)
set_target_properties(${TARGET} PROPERTIES
  PREFIX ""
  OUTPUT_NAME "native-whisper-addon"
  SUFFIX ".node"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
)

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
)
string(REPLACE "\n" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${TARGET} PRIVATE ${NODE_ADDON_API_DIR})

find_package(Threads REQUIRED)
target_link_libraries(${TARGET} PRIVATE ${CMAKE_JS_LIB} whisper Threads::Threads)

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(
    COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS}
  )
endif()
