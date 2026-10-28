add_library(greeter greeter.cpp)
target_include_directories(greeter PUBLIC include)
target_compile_features(greeter PUBLIC cxx_std_17)
